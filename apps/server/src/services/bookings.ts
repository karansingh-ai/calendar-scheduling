import { assignRoundRobin, computeSlots, isSlotAvailable, type Slot } from "@scheduler/core";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context";
import { bookingHosts, bookings, users, type BookingLocation, type EventQuestion } from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/http";
import { audit, type AuditActor } from "./audit";
import { buildSlotQuery, fetchCalendarBusy, loadEventType, type LoadedEventType } from "./availability";
import { enqueue } from "./jobs";
import { emitBookingEvent } from "./webhooks";

export type BookingRow = typeof bookings.$inferSelect;

export interface InviteeInput {
  name: string;
  email: string;
  timezone: string;
  answers?: Record<string, string | boolean>;
}

export interface CreateBookingInput {
  eventTypeId: string;
  start: Date;
  invitee: InviteeInput;
  actor: AuditActor;
  /** When set, this booking replaces an existing one (reschedule). */
  reschedule?: { booking: BookingRow; by: "host" | "invitee" | "admin"; reason?: string };
}

/**
 * Keep answers to the event's current questions. `requireAll: false` is for reschedules: the invitee answered
 * when they booked, and questions added since then must not block moving the meeting.
 */
export function validateAnswers(questions: EventQuestion[], answers: Record<string, string | boolean> = {}, { requireAll = true } = {}) {
  const clean: Record<string, string | boolean> = {};
  for (const q of questions) {
    const v = answers[q.id];
    const empty = v === undefined || v === null || v === "" || v === false;
    if (q.required && empty && requireAll) throw badRequest(`"${q.label}" is required`, [{ path: `answers.${q.id}`, message: "Required" }]);
    if (empty) continue;
    if (q.type === "checkbox") {
      clean[q.id] = Boolean(v);
    } else {
      const s = String(v).slice(0, 5000);
      if (q.type === "select" && q.options && !q.options.includes(s)) throw badRequest(`"${q.label}" has an invalid choice`);
      clean[q.id] = s;
    }
  }
  return clean;
}

function locationFor(loaded: LoadedEventType, joinUrl?: string): BookingLocation {
  const loc = loaded.eventType.location;
  return { type: loc.type, value: loc.value, joinUrl: joinUrl ?? (loc.type === "link" ? loc.value : undefined) };
}

function locationText(l: BookingLocation): string | undefined {
  if (l.joinUrl) return l.joinUrl;
  return l.value;
}

/**
 * Create a booking (or reschedule one). Availability is re-checked inside a transaction that locks
 * the candidate hosts' rows, so two concurrent requests for the same slot cannot both succeed.
 */
export async function createBooking(ctx: AppContext, input: CreateBookingInput): Promise<{ booking: BookingRow; manageToken: string }> {
  const loaded = await loadEventType(ctx.db, input.eventTypeId);
  if (!loaded || !loaded.eventType.active) throw notFound("This event type is not available");
  if (loaded.hosts.length === 0) throw conflict("This event type has no available hosts", "no_hosts");
  const et = loaded.eventType;
  const answers = validateAnswers(et.questions, input.invitee.answers, { requireAll: !input.reschedule });
  const start = input.start;
  if (Number.isNaN(start.getTime())) throw badRequest("Invalid start time");

  // Calendar lookups happen outside the transaction (network calls).
  const window = { from: new Date(start.getTime() - 1), to: new Date(start.getTime() + 1) };
  const calendarBusy = await fetchCalendarBusy(ctx, loaded, window.from, window.to);
  const manageToken = randomToken(24);

  const result = await ctx.db.transaction(async (tx) => {
    const hostIds = loaded.hosts.map((h) => h.user.id).sort();
    // Serialize bookings per host.
    await tx.select({ id: users.id }).from(users).where(inArray(users.id, hostIds)).orderBy(users.id).for("update");

    // The booking being moved must still be live: two concurrent reschedules (or a cancel racing a
    // reschedule) would otherwise both succeed and leave two meetings.
    if (input.reschedule) {
      const [original] = await tx
        .select({ status: bookings.status })
        .from(bookings)
        .where(eq(bookings.id, input.reschedule.booking.id))
        .for("update");
      if (original?.status !== "confirmed") throw conflict("This booking has already been changed. Refresh and try again.", "booking_changed");
    }

    const query = await buildSlotQuery(ctx, tx, loaded, window.from, window.to, {
      calendarBusy,
      excludeBookingId: input.reschedule?.booking.id,
    });
    const slot: Slot | null = isSlotAvailable(query, start.getTime());
    if (!slot) throw conflict("That time is no longer available. Please pick another slot.", "slot_unavailable");

    let assignedHosts: string[];
    let primaryHost: string;
    let assignmentReason: string | null = null;
    if (et.kind === "round_robin") {
      const candidates = query.hosts.filter((h) => slot.hostIds.includes(h.hostId));
      const pick = assignRoundRobin(candidates, et.rrStrategy, `${et.id}:${start.getTime()}`);
      primaryHost = pick.hostId;
      assignedHosts = [pick.hostId];
      assignmentReason = pick.reason;
    } else if (et.kind === "collective") {
      assignedHosts = slot.hostIds;
      primaryHost = et.ownerUserId && slot.hostIds.includes(et.ownerUserId) ? et.ownerUserId : slot.hostIds[0];
    } else {
      assignedHosts = slot.hostIds;
      primaryHost = slot.hostIds[0];
    }

    const [booking] = await tx
      .insert(bookings)
      .values({
        eventTypeId: et.id,
        hostUserId: primaryHost,
        startAt: new Date(slot.start),
        endAt: new Date(slot.end),
        bufferBeforeMinutes: et.bufferBeforeMinutes,
        bufferAfterMinutes: et.bufferAfterMinutes,
        title: `${et.title} with ${input.invitee.name}`,
        location: locationFor(loaded),
        inviteeName: input.invitee.name.trim(),
        inviteeEmail: input.invitee.email.trim().toLowerCase(),
        inviteeTimezone: input.invitee.timezone,
        answers,
        manageTokenHash: sha256(manageToken),
        manageTokenEnc: ctx.encrypter.encrypt(manageToken),
        icsUid: input.reschedule?.booking.icsUid ?? `${randomToken(16)}@${new URL(ctx.config.APP_URL).hostname}`,
        assignmentReason,
        rescheduledFromId: input.reschedule?.booking.id ?? null,
      })
      .returning();
    await tx.insert(bookingHosts).values(assignedHosts.map((userId) => ({ bookingId: booking.id, userId })));

    if (input.reschedule) {
      await tx
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledBy: input.reschedule.by,
          cancelReason: input.reschedule.reason ? `Rescheduled: ${input.reschedule.reason}` : "Rescheduled",
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, input.reschedule.booking.id));
    }
    return { booking, assignedHosts, primaryHost };
  });

  // Side effects after commit.
  let booking = result.booking;
  if (input.reschedule) await ctx.calendars.deleteBookingEvents(input.reschedule.booking.id);
  const wantsVideo = et.location.type === "google_meet" || et.location.type === "microsoft_teams";
  const description = [
    `${et.title}`,
    `Invitee: ${booking.inviteeName} <${booking.inviteeEmail}>`,
    ...Object.entries(answers).map(([k, v]) => `${et.questions.find((q) => q.id === k)?.label ?? k}: ${v}`),
    `Manage: ${ctx.config.APP_URL}/booking/${booking.id}`,
  ].join("\n");
  const joinUrl = await ctx.calendars.createBookingEvents(
    booking.id,
    result.assignedHosts,
    {
      title: booking.title,
      description,
      start: booking.startAt,
      end: booking.endAt,
      location: locationText(booking.location),
      video: wantsVideo,
      requestId: booking.id,
    },
    result.primaryHost,
  );
  if (joinUrl) {
    const [updated] = await ctx.db
      .update(bookings)
      .set({ location: locationFor(loaded, joinUrl), updatedAt: new Date() })
      .where(eq(bookings.id, booking.id))
      .returning();
    booking = updated;
  }

  const kind = input.reschedule ? "rescheduled" : "confirmed";
  await enqueue(ctx.db, "email.booking", { bookingId: booking.id, kind }, { dedupeKey: `email:${booking.id}:${kind}` });
  for (const minutes of et.reminderMinutes) {
    const runAt = new Date(booking.startAt.getTime() - minutes * 60_000);
    if (runAt.getTime() > Date.now() + 60_000) {
      await enqueue(ctx.db, "email.reminder", { bookingId: booking.id, minutes }, { runAt, dedupeKey: `reminder:${booking.id}:${minutes}` });
    }
  }
  if (input.reschedule) {
    await emitBookingEvent(ctx, "booking.rescheduled", booking.id, { previousBookingId: input.reschedule.booking.id });
  } else {
    await emitBookingEvent(ctx, "booking.created", booking.id);
  }
  await audit(ctx.db, input.actor, input.reschedule ? "booking.rescheduled" : "booking.created", { type: "booking", id: booking.id }, {
    eventTypeId: et.id,
    start: booking.startAt.toISOString(),
    hosts: result.assignedHosts,
    ...(input.reschedule ? { previousBookingId: input.reschedule.booking.id } : {}),
    ...(booking.assignmentReason ? { assignmentReason: booking.assignmentReason } : {}),
  });
  return { booking, manageToken };
}

export async function cancelBooking(
  ctx: AppContext,
  booking: BookingRow,
  opts: { by: "host" | "invitee" | "admin"; reason?: string; actor: AuditActor },
): Promise<BookingRow> {
  if (booking.status === "cancelled") throw conflict("This booking is already cancelled", "already_cancelled");
  // Conditional update, so a cancel racing another cancel or a reschedule only takes effect once.
  const [updated] = await ctx.db
    .update(bookings)
    .set({ status: "cancelled", cancelledBy: opts.by, cancelReason: opts.reason?.slice(0, 1000) ?? null, updatedAt: new Date() })
    .where(and(eq(bookings.id, booking.id), eq(bookings.status, "confirmed")))
    .returning();
  if (!updated) throw conflict("This booking is already cancelled", "already_cancelled");
  await ctx.calendars.deleteBookingEvents(booking.id);
  await enqueue(ctx.db, "email.booking", { bookingId: booking.id, kind: "cancelled" }, { dedupeKey: `email:${booking.id}:cancelled` });
  await emitBookingEvent(ctx, "booking.cancelled", booking.id);
  await audit(ctx.db, opts.actor, "booking.cancelled", { type: "booking", id: booking.id }, { by: opts.by, reason: opts.reason });
  return updated;
}

export async function findBookingByToken(ctx: AppContext, id: string, token: string): Promise<BookingRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [b] = await ctx.db.select().from(bookings).where(eq(bookings.id, id));
  if (!b || b.manageTokenHash !== sha256(token)) return null;
  return b;
}

export async function bookingHostsOf(ctx: AppContext, bookingIds: string[]) {
  if (bookingIds.length === 0) return new Map<string, { id: string; name: string; email: string }[]>();
  const rows = await ctx.db
    .select({ bookingId: bookingHosts.bookingId, id: users.id, name: users.name, email: users.email })
    .from(bookingHosts)
    .innerJoin(users, eq(bookingHosts.userId, users.id))
    .where(inArray(bookingHosts.bookingId, bookingIds));
  const map = new Map<string, { id: string; name: string; email: string }[]>();
  for (const r of rows) {
    if (!map.has(r.bookingId)) map.set(r.bookingId, []);
    map.get(r.bookingId)!.push({ id: r.id, name: r.name, email: r.email });
  }
  return map;
}

export { computeSlots };
