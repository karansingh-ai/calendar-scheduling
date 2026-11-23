import { and, desc, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "@timebook/core";
import { actor, currentUser, isAdmin, type AppEnv } from "../auth/middleware";
import { bookingHosts, bookings, eventTypes } from "../db/schema";
import { forbidden, notFound, parseBody, parseQuery } from "../lib/http";
import { audit } from "../services/audit";
import { bookingHostsOf, cancelBooking, createBooking, type BookingRow } from "../services/bookings";
import { canManageBooking, canViewEventType } from "../services/permissions";
import { serializeBooking } from "../services/serialize";
import { loadEventType } from "../services/availability";

export const inviteeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((n) => !/[\u0000-\u001f\u007f]/.test(n), "Name cannot contain line breaks or control characters"),
  email: z.string().email().max(320),
  timezone: z.string().refine(isValidTimeZone, "Unknown time zone"),
});

export const bookingRoutes = new Hono<AppEnv>();

bookingRoutes.get("/", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const q = parseQuery(
    c,
    z.object({
      status: z.enum(["upcoming", "past", "cancelled", "all"]).default("upcoming"),
      scope: z.enum(["mine", "org"]).default("mine"),
      eventTypeId: z.string().uuid().optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  );
  if (q.scope === "org" && !isAdmin(user)) throw forbidden("Only admins can list all bookings");
  const now = new Date();
  const conds = [];
  if (q.scope === "mine") {
    conds.push(inArray(bookings.id, ctx.db.select({ id: bookingHosts.bookingId }).from(bookingHosts).where(eq(bookingHosts.userId, user.id))));
  }
  if (q.status === "upcoming") conds.push(eq(bookings.status, "confirmed"), gte(bookings.endAt, now));
  if (q.status === "past") conds.push(eq(bookings.status, "confirmed"), lt(bookings.endAt, now));
  if (q.status === "cancelled") conds.push(eq(bookings.status, "cancelled"));
  if (q.eventTypeId) conds.push(eq(bookings.eventTypeId, q.eventTypeId));
  if (q.from) conds.push(gte(bookings.startAt, new Date(q.from)));
  if (q.to) conds.push(lt(bookings.startAt, new Date(q.to)));
  const rows = await ctx.db
    .select({ booking: bookings, eventType: eventTypes })
    .from(bookings)
    .innerJoin(eventTypes, eq(bookings.eventTypeId, eventTypes.id))
    .where(and(...conds))
    .orderBy(q.status === "upcoming" ? asc(bookings.startAt) : desc(bookings.startAt))
    .limit(q.limit)
    .offset(q.offset);
  const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(bookings).where(and(...conds));
  const hosts = await bookingHostsOf(ctx, rows.map((r) => r.booking.id));
  return c.json({
    bookings: rows.map((r) => serializeBooking(r.booking, { eventType: r.eventType, hosts: hosts.get(r.booking.id) })),
    total: Number(total),
  });
});

async function loadForUser(c: Context<AppEnv>) {
  const ctx = c.get("ctx");
  const id = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) throw notFound("Booking not found");
  const [row] = await ctx.db
    .select({ booking: bookings, eventType: eventTypes })
    .from(bookings)
    .innerJoin(eventTypes, eq(bookings.eventTypeId, eventTypes.id))
    .where(eq(bookings.id, id));
  if (!row || !(await canManageBooking(ctx.db, currentUser(c), row.booking, row.eventType))) throw notFound("Booking not found");
  return row;
}

bookingRoutes.get("/:id", async (c) => {
  const ctx = c.get("ctx");
  const row = await loadForUser(c);
  const hosts = await bookingHostsOf(ctx, [row.booking.id]);
  let history: BookingRow | null = null;
  if (row.booking.rescheduledFromId) [history] = await ctx.db.select().from(bookings).where(eq(bookings.id, row.booking.rescheduledFromId));
  return c.json({
    booking: serializeBooking(row.booking, { eventType: row.eventType, hosts: hosts.get(row.booking.id) }),
    eventType: { questions: row.eventType.questions },
    rescheduledFrom: history ? { id: history.id, start: history.startAt.toISOString() } : null,
  });
});

/** Book on someone's behalf (host or integration). Same availability rules as the public page. */
bookingRoutes.post("/", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(
    c,
    z.object({
      eventTypeId: z.string().uuid(),
      start: z.string().datetime({ offset: true }),
      invitee: inviteeSchema,
      answers: z.record(z.union([z.string(), z.boolean()])).optional(),
    }),
  );
  const loaded = await loadEventType(ctx.db, body.eventTypeId);
  if (!loaded || !(await canViewEventType(ctx.db, user, loaded.eventType))) throw notFound("Event type not found");
  const { booking, manageToken } = await createBooking(ctx, {
    eventTypeId: body.eventTypeId,
    start: new Date(body.start),
    invitee: { ...body.invitee, answers: body.answers },
    actor: actor(c),
  });
  const hosts = await bookingHostsOf(ctx, [booking.id]);
  return c.json(
    {
      booking: serializeBooking(booking, { eventType: loaded.eventType, hosts: hosts.get(booking.id) }),
      manageUrl: `${ctx.config.APP_URL}/booking/${booking.id}?token=${encodeURIComponent(manageToken)}`,
    },
    201,
  );
});

bookingRoutes.post("/:id/cancel", async (c) => {
  const ctx = c.get("ctx");
  const row = await loadForUser(c);
  const body = await parseBody(c, z.object({ reason: z.string().max(1000).optional() }));
  const user = currentUser(c);
  const isHost = (await bookingHostsOf(ctx, [row.booking.id])).get(row.booking.id)?.some((h) => h.id === user.id);
  const updated = await cancelBooking(ctx, row.booking, { by: isHost ? "host" : "admin", reason: body.reason, actor: actor(c) });
  return c.json({ booking: serializeBooking(updated, { eventType: row.eventType }) });
});

bookingRoutes.post("/:id/reschedule", async (c) => {
  const ctx = c.get("ctx");
  const row = await loadForUser(c);
  if (row.booking.status !== "confirmed") throw notFound("Only confirmed bookings can be rescheduled");
  const body = await parseBody(c, z.object({ start: z.string().datetime({ offset: true }), reason: z.string().max(1000).optional() }));
  const { booking } = await createBooking(ctx, {
    eventTypeId: row.booking.eventTypeId,
    start: new Date(body.start),
    invitee: { name: row.booking.inviteeName, email: row.booking.inviteeEmail, timezone: row.booking.inviteeTimezone, answers: row.booking.answers },
    actor: actor(c),
    reschedule: { booking: row.booking, by: "host", reason: body.reason },
  });
  return c.json({ booking: serializeBooking(booking, { eventType: row.eventType }) }, 201);
});

bookingRoutes.post("/:id/no-show", async (c) => {
  const ctx = c.get("ctx");
  const row = await loadForUser(c);
  const body = await parseBody(c, z.object({ noShow: z.boolean() }));
  const [updated] = await ctx.db.update(bookings).set({ noShow: body.noShow, updatedAt: new Date() }).where(eq(bookings.id, row.booking.id)).returning();
  await audit(ctx.db, actor(c), "booking.no_show", { type: "booking", id: row.booking.id }, { noShow: body.noShow });
  return c.json({ booking: serializeBooking(updated, { eventType: row.eventType }) });
});
