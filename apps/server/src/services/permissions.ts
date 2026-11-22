import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { bookingHosts, eventTypeHosts, teamMembers } from "../db/schema";
import { isAdmin } from "../auth/middleware";
import type { EventTypeRow } from "./availability";
import type { BookingRow } from "./bookings";
import type { UserRow } from "./users";

export async function teamRole(db: Db, userId: string, teamId: string) {
  const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return m?.role ?? null;
}

export async function canManageEventType(db: Db, user: UserRow, et: EventTypeRow) {
  if (isAdmin(user)) return true;
  if (et.ownerUserId === user.id) return true;
  if (et.teamId) return (await teamRole(db, user.id, et.teamId)) === "manager";
  return false;
}

export async function canViewEventType(db: Db, user: UserRow, et: EventTypeRow) {
  if (await canManageEventType(db, user, et)) return true;
  if (et.teamId && (await teamRole(db, user.id, et.teamId))) return true;
  const [host] = await db
    .select()
    .from(eventTypeHosts)
    .where(and(eq(eventTypeHosts.eventTypeId, et.id), eq(eventTypeHosts.userId, user.id)));
  return Boolean(host);
}

/** Hosts of a booking, admins, and managers of the event type's team may act on a booking. */
export async function canManageBooking(db: Db, user: UserRow, booking: BookingRow, et?: EventTypeRow) {
  if (isAdmin(user)) return true;
  const [host] = await db
    .select()
    .from(bookingHosts)
    .where(and(eq(bookingHosts.bookingId, booking.id), eq(bookingHosts.userId, user.id)));
  if (host) return true;
  if (et?.teamId) return (await teamRole(db, user.id, et.teamId)) === "manager";
  return false;
}
