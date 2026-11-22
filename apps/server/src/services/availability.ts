import { computeSlots, DAY, type HostInput, type Interval, type SlotQuery, type SlotResult } from "@scheduler/core";
import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { bookingHosts, bookings, eventTypeHosts, eventTypes, schedules, users } from "../db/schema";
import type { UserRow } from "./users";

export type EventTypeRow = typeof eventTypes.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;

export interface LoadedHost {
  user: UserRow;
  priority: number;
  weight: number;
  schedule: ScheduleRow | null;
}

export interface LoadedEventType {
  eventType: EventTypeRow;
  hosts: LoadedHost[];
}

const FAIRNESS_WINDOW_DAYS = 30;

/** Load an event type with its hosts and each host's schedule. Disabled users are skipped. */
export async function loadEventType(db: Db, eventTypeId: string): Promise<LoadedEventType | null> {
  const [eventType] = await db.select().from(eventTypes).where(eq(eventTypes.id, eventTypeId));
  if (!eventType) return null;

  const hostRows = await db
    .select({ host: eventTypeHosts, user: users })
    .from(eventTypeHosts)
    .innerJoin(users, eq(eventTypeHosts.userId, users.id))
    .where(eq(eventTypeHosts.eventTypeId, eventTypeId));

  let hosts: { user: UserRow; priority: number; weight: number; scheduleId: string | null }[] = hostRows.map((r) => ({
    user: r.user,
    priority: r.host.priority,
    weight: r.host.weight,
    scheduleId: r.host.scheduleId,
  }));
  if (hosts.length === 0 && eventType.ownerUserId) {
    const [owner] = await db.select().from(users).where(eq(users.id, eventType.ownerUserId));
    if (owner) hosts = [{ user: owner, priority: 0, weight: 1, scheduleId: null }];
  }
  hosts = hosts.filter((h) => !h.user.disabledAt);
  if (hosts.length === 0) return { eventType, hosts: [] };

  const userIds = hosts.map((h) => h.user.id);
  const allSchedules = await db.select().from(schedules).where(inArray(schedules.userId, userIds));
  return {
    eventType,
    hosts: hosts.map((h) => {
      const mine = allSchedules.filter((s) => s.userId === h.user.id);
      const schedule =
        (h.scheduleId && mine.find((s) => s.id === h.scheduleId)) || mine.find((s) => s.isDefault) || mine[0] || null;
      return { user: h.user, priority: h.priority, weight: h.weight, schedule };
    }),
  };
}

/** Busy intervals from this app's own confirmed bookings, per host, expanded by each booking's buffers. */
async function bookingBusy(db: Db, userIds: string[], from: Date, to: Date, excludeEventTypeId?: string, excludeBookingId?: string) {
  const rows = await db
    .select({
      userId: bookingHosts.userId,
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      before: bookings.bufferBeforeMinutes,
      after: bookings.bufferAfterMinutes,
      eventTypeId: bookings.eventTypeId,
    })
    .from(bookingHosts)
    .innerJoin(bookings, eq(bookingHosts.bookingId, bookings.id))
    .where(
      and(
        inArray(bookingHosts.userId, userIds),
        eq(bookings.status, "confirmed"),
        lt(bookings.startAt, to),
        gt(bookings.endAt, from),
        excludeEventTypeId ? ne(bookings.eventTypeId, excludeEventTypeId) : undefined,
        excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
      ),
    );
  const out = new Map<string, Interval[]>(userIds.map((id) => [id, []]));
  for (const r of rows) {
    out.get(r.userId)!.push({ start: r.startAt.getTime() - r.before * 60_000, end: r.endAt.getTime() + r.after * 60_000 });
  }
  return out;
}

async function eventBookingsFor(db: Db, eventTypeId: string, userIds: string[], from: Date, to: Date, excludeBookingId?: string) {
  const rows = await db
    .select({ userId: bookingHosts.userId, startAt: bookings.startAt, endAt: bookings.endAt })
    .from(bookingHosts)
    .innerJoin(bookings, eq(bookingHosts.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.eventTypeId, eventTypeId),
        inArray(bookingHosts.userId, userIds),
        eq(bookings.status, "confirmed"),
        lt(bookings.startAt, to),
        gt(bookings.endAt, from),
        excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
      ),
    );
  const out = new Map<string, Interval[]>(userIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.userId)!.push({ start: r.startAt.getTime(), end: r.endAt.getTime() });
  return out;
}

async function fairnessStats(db: Db, eventTypeId: string, userIds: string[]) {
  const since = new Date(Date.now() - FAIRNESS_WINDOW_DAYS * DAY);
  const rows = await db
    .select({
      userId: bookings.hostUserId,
      count: sql<number>`count(*) filter (where ${bookings.createdAt} >= ${since.toISOString()}::timestamptz)::int`,
      last: sql<Date | null>`max(${bookings.createdAt})`,
    })
    .from(bookings)
    .where(and(eq(bookings.eventTypeId, eventTypeId), inArray(bookings.hostUserId, userIds), eq(bookings.status, "confirmed")))
    .groupBy(bookings.hostUserId);
  return new Map(rows.map((r) => [r.userId, { count: Number(r.count), last: r.last ? new Date(r.last).getTime() : null }]));
}

export interface BuildOptions {
  explain?: boolean;
  excludeBookingId?: string;
  /** Pre-fetched calendar busy time (lets the booking flow fetch it outside the DB transaction). */
  calendarBusy?: Map<string, Interval[]>;
}

/** Fetch calendar busy time for all hosts of an event type, with margins for buffers and weekly limits. */
export async function fetchCalendarBusy(ctx: AppContext, loaded: LoadedEventType, from: Date, to: Date) {
  const margin = DAY;
  return ctx.calendars.busyForUsers(
    loaded.hosts.map((h) => h.user.id),
    new Date(from.getTime() - margin),
    new Date(to.getTime() + margin),
  );
}

/** Assemble the engine query for an event type over [from, to). `db` may be a transaction. */
export async function buildSlotQuery(
  ctx: AppContext,
  db: Db,
  loaded: LoadedEventType,
  from: Date,
  to: Date,
  opts: BuildOptions = {},
): Promise<SlotQuery> {
  const et = loaded.eventType;
  const hosts = loaded.hosts.filter((h) => h.schedule);
  const userIds = hosts.map((h) => h.user.id);
  const margin = 8 * DAY; // weekly limits look at the whole ISO week
  const wideFrom = new Date(from.getTime() - margin);
  const wideTo = new Date(to.getTime() + margin);

  const calendarBusy = opts.calendarBusy ?? (await fetchCalendarBusy(ctx, loaded, from, to));
  const ownBusy = await bookingBusy(db, userIds, wideFrom, wideTo, et.kind === "group" ? et.id : undefined, opts.excludeBookingId);
  const eventBookings = await eventBookingsFor(db, et.id, userIds, wideFrom, wideTo, opts.excludeBookingId);
  const fairness = et.kind === "round_robin" ? await fairnessStats(db, et.id, userIds) : new Map();

  const hostInputs: HostInput[] = hosts.map((h) => ({
    hostId: h.user.id,
    schedule: { timezone: h.schedule!.timezone, weekly: h.schedule!.weekly, overrides: h.schedule!.overrides },
    busy: [...(calendarBusy.get(h.user.id) ?? []), ...(ownBusy.get(h.user.id) ?? [])],
    eventBookings: eventBookings.get(h.user.id) ?? [],
    priority: h.priority,
    weight: h.weight,
    fairnessCount: fairness.get(h.user.id)?.count ?? 0,
    lastBookedAt: fairness.get(h.user.id)?.last ?? null,
  }));

  return {
    kind: et.kind,
    rangeStart: from.getTime(),
    rangeEnd: to.getTime(),
    now: Date.now(),
    durationMinutes: et.durationMinutes,
    slotIntervalMinutes: et.slotIntervalMinutes,
    bufferBeforeMinutes: et.bufferBeforeMinutes,
    bufferAfterMinutes: et.bufferAfterMinutes,
    minimumNoticeMinutes: et.minimumNoticeMinutes,
    bookingWindow: et.bookingWindow,
    dailyLimit: et.dailyLimit,
    weeklyLimit: et.weeklyLimit,
    seats: et.seats,
    maxImbalance: et.rrStrategy === "equal_distribution" ? (et.rrMaxImbalance ?? null) : null,
    hosts: hostInputs,
    explain: opts.explain,
  };
}

export const MAX_RANGE_DAYS = 62;

export async function getSlots(ctx: AppContext, loaded: LoadedEventType, from: Date, to: Date, opts: BuildOptions = {}): Promise<SlotResult> {
  if (loaded.hosts.length === 0) return { slots: [] };
  const query = await buildSlotQuery(ctx, ctx.db, loaded, from, to, opts);
  return computeSlots(query);
}
