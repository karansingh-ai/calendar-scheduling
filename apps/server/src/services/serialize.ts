import type { bookings, eventTypes, schedules } from "../db/schema";
import type { LoadedEventType } from "./availability";

type BookingRow = typeof bookings.$inferSelect;
type EventTypeRow = typeof eventTypes.$inferSelect;
type ScheduleRow = typeof schedules.$inferSelect;

export function serializeBooking(
  b: BookingRow,
  extra: { eventType?: Pick<EventTypeRow, "id" | "slug" | "title" | "kind">; hosts?: { id: string; name: string; email: string }[] } = {},
) {
  return {
    id: b.id,
    status: b.status,
    title: b.title,
    start: b.startAt.toISOString(),
    end: b.endAt.toISOString(),
    eventType: extra.eventType ? { id: extra.eventType.id, slug: extra.eventType.slug, title: extra.eventType.title, kind: extra.eventType.kind } : { id: b.eventTypeId },
    hostUserId: b.hostUserId,
    hosts: extra.hosts ?? [],
    location: b.location,
    invitee: { name: b.inviteeName, email: b.inviteeEmail, timezone: b.inviteeTimezone },
    answers: b.answers,
    assignmentReason: b.assignmentReason,
    cancelReason: b.cancelReason,
    cancelledBy: b.cancelledBy,
    rescheduledFromId: b.rescheduledFromId,
    noShow: b.noShow,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export type SerializedBooking = ReturnType<typeof serializeBooking>;

export function serializeEventType(et: EventTypeRow, hosts: LoadedEventType["hosts"] | { userId: string; priority: number; weight: number; scheduleId: string | null; name?: string; email?: string }[] = []) {
  return {
    id: et.id,
    ownerUserId: et.ownerUserId,
    teamId: et.teamId,
    slug: et.slug,
    title: et.title,
    description: et.description,
    kind: et.kind,
    durationMinutes: et.durationMinutes,
    slotIntervalMinutes: et.slotIntervalMinutes,
    bufferBeforeMinutes: et.bufferBeforeMinutes,
    bufferAfterMinutes: et.bufferAfterMinutes,
    minimumNoticeMinutes: et.minimumNoticeMinutes,
    bookingWindow: et.bookingWindow,
    dailyLimit: et.dailyLimit,
    weeklyLimit: et.weeklyLimit,
    seats: et.seats,
    location: et.location,
    questions: et.questions,
    reminderMinutes: et.reminderMinutes,
    rrStrategy: et.rrStrategy,
    rrMaxImbalance: et.rrMaxImbalance,
    redirectUrl: et.redirectUrl,
    color: et.color,
    hidden: et.hidden,
    active: et.active,
    hosts: hosts.map((h) =>
      "user" in h
        ? { userId: h.user.id, name: h.user.name, email: h.user.email, priority: h.priority, weight: h.weight, scheduleId: h.schedule?.id ?? null }
        : h,
    ),
    createdAt: et.createdAt.toISOString(),
    updatedAt: et.updatedAt.toISOString(),
  };
}

export function serializeSchedule(s: ScheduleRow) {
  return {
    id: s.id,
    userId: s.userId,
    name: s.name,
    timezone: s.timezone,
    weekly: s.weekly,
    overrides: s.overrides,
    isDefault: s.isDefault,
  };
}
