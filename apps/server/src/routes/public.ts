import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { clientIp, type AppEnv } from "../auth/middleware";
import { eventTypes, teams, users } from "../db/schema";
import { conflict, HttpError, notFound, parseBody, parseQuery } from "../lib/http";
import { RateLimiter } from "../lib/rateLimit";
import { getSlots, loadEventType, type LoadedEventType } from "../services/availability";
import { bookingHostsOf, cancelBooking, createBooking, findBookingByToken } from "../services/bookings";
import { serializeBooking } from "../services/serialize";
import { getOrgSettings } from "../services/users";
import { inviteeSchema } from "./bookings";
import { parseRange, slotsQuery } from "./eventTypes";

const slotLimiter = new RateLimiter(240, 60_000);
const bookingLimiter = new RateLimiter(30, 60 * 60_000);

function limit(c: Context<AppEnv>, limiter: RateLimiter) {
  if (!limiter.check(clientIp(c) ?? "unknown")) throw new HttpError(429, "rate_limited", "Too many requests. Please wait a moment.");
}

function publicEventType(loaded: LoadedEventType, owner: { kind: "user"; name: string; username: string } | { kind: "team"; name: string; slug: string }) {
  const et = loaded.eventType;
  const showValue = et.location.type === "in_person" || et.location.type === "custom";
  return {
    id: et.id,
    slug: et.slug,
    title: et.title,
    description: et.description,
    kind: et.kind,
    durationMinutes: et.durationMinutes,
    color: et.color,
    seats: et.seats,
    questions: et.questions,
    location: { type: et.location.type, value: showValue ? et.location.value : undefined },
    hosts: et.kind === "round_robin" ? [] : loaded.hosts.map((h) => ({ name: h.user.name })),
    owner,
    redirectUrl: et.redirectUrl,
    hostTimezone: loaded.hosts[0]?.schedule?.timezone ?? loaded.hosts[0]?.user.timezone ?? "UTC",
  };
}

async function org(c: Context<AppEnv>) {
  const ctx = c.get("ctx");
  const o = await getOrgSettings(ctx.db);
  return { name: o.name, brandColor: o.brandColor, logoUrl: o.logoUrl, appName: ctx.config.APP_NAME };
}

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/users/:username", async (c) => {
  const { db } = c.get("ctx");
  const [user] = await db.select().from(users).where(eq(users.username, c.req.param("username").toLowerCase()));
  if (!user || user.disabledAt) throw notFound("Page not found");
  const rows = await db
    .select()
    .from(eventTypes)
    .where(and(eq(eventTypes.ownerUserId, user.id), eq(eventTypes.active, true), eq(eventTypes.hidden, false)))
    .orderBy(eventTypes.createdAt);
  return c.json({
    org: await org(c),
    user: { name: user.name, username: user.username, welcomeMessage: user.welcomeMessage },
    eventTypes: rows.map((et) => ({ id: et.id, slug: et.slug, title: et.title, description: et.description, durationMinutes: et.durationMinutes, kind: et.kind, color: et.color })),
  });
});

publicRoutes.get("/users/:username/event-types/:slug", async (c) => {
  const { db } = c.get("ctx");
  const [user] = await db.select().from(users).where(eq(users.username, c.req.param("username").toLowerCase()));
  if (!user || user.disabledAt) throw notFound("Page not found");
  const [et] = await db
    .select()
    .from(eventTypes)
    .where(and(eq(eventTypes.ownerUserId, user.id), eq(eventTypes.slug, c.req.param("slug").toLowerCase()), eq(eventTypes.active, true)));
  if (!et) throw notFound("This event type does not exist or is turned off");
  const loaded = (await loadEventType(db, et.id))!;
  return c.json({ org: await org(c), eventType: publicEventType(loaded, { kind: "user", name: user.name, username: user.username }) });
});

publicRoutes.get("/teams/:slug", async (c) => {
  const { db } = c.get("ctx");
  const [team] = await db.select().from(teams).where(eq(teams.slug, c.req.param("slug").toLowerCase()));
  if (!team) throw notFound("Page not found");
  const rows = await db
    .select()
    .from(eventTypes)
    .where(and(eq(eventTypes.teamId, team.id), eq(eventTypes.active, true), eq(eventTypes.hidden, false)))
    .orderBy(eventTypes.createdAt);
  return c.json({
    org: await org(c),
    team: { name: team.name, slug: team.slug },
    eventTypes: rows.map((et) => ({ id: et.id, slug: et.slug, title: et.title, description: et.description, durationMinutes: et.durationMinutes, kind: et.kind, color: et.color })),
  });
});

publicRoutes.get("/teams/:teamSlug/event-types/:slug", async (c) => {
  const { db } = c.get("ctx");
  const [team] = await db.select().from(teams).where(eq(teams.slug, c.req.param("teamSlug").toLowerCase()));
  if (!team) throw notFound("Page not found");
  const [et] = await db
    .select()
    .from(eventTypes)
    .where(and(eq(eventTypes.teamId, team.id), eq(eventTypes.slug, c.req.param("slug").toLowerCase()), eq(eventTypes.active, true)));
  if (!et) throw notFound("This event type does not exist or is turned off");
  const loaded = (await loadEventType(db, et.id))!;
  return c.json({ org: await org(c), eventType: publicEventType(loaded, { kind: "team", name: team.name, slug: team.slug }) });
});

async function activeEventType(c: Context<AppEnv>) {
  const id = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) throw notFound("Event type not found");
  const loaded = await loadEventType(c.get("ctx").db, id);
  if (!loaded || !loaded.eventType.active) throw notFound("Event type not found");
  return loaded;
}

publicRoutes.get("/event-types/:id/slots", async (c) => {
  limit(c, slotLimiter);
  const ctx = c.get("ctx");
  const loaded = await activeEventType(c);
  const q = parseQuery(c, slotsQuery.omit({ debug: true }).extend({ rescheduleBookingId: z.string().uuid().optional() }));
  const { from, to } = parseRange(q);
  const result = await getSlots(ctx, loaded, from, to, { excludeBookingId: q.rescheduleBookingId });
  return c.json({
    slots: result.slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), seatsRemaining: s.seatsRemaining })),
  });
});

publicRoutes.post("/event-types/:id/bookings", async (c) => {
  limit(c, bookingLimiter);
  const ctx = c.get("ctx");
  const loaded = await activeEventType(c);
  const body = await parseBody(
    c,
    z.object({ start: z.string().datetime({ offset: true }), invitee: inviteeSchema, answers: z.record(z.union([z.string(), z.boolean()])).optional() }),
  );
  const { booking, manageToken } = await createBooking(ctx, {
    eventTypeId: loaded.eventType.id,
    start: new Date(body.start),
    invitee: { ...body.invitee, answers: body.answers },
    actor: { userId: null, label: `invitee:${body.invitee.email.toLowerCase()}`, ip: clientIp(c) },
  });
  const hosts = await bookingHostsOf(ctx, [booking.id]);
  return c.json(
    {
      booking: serializeBooking(booking, { eventType: loaded.eventType, hosts: hosts.get(booking.id)?.map((h) => ({ ...h, email: "" })) }),
      manageToken,
      redirectUrl: loaded.eventType.redirectUrl,
    },
    201,
  );
});

async function managed(c: Context<AppEnv>, token: string | undefined) {
  const ctx = c.get("ctx");
  const booking = token ? await findBookingByToken(ctx, c.req.param("id") ?? "", token) : null;
  if (!booking) throw notFound("This booking link is invalid");
  return booking;
}

publicRoutes.get("/bookings/:id", async (c) => {
  const ctx = c.get("ctx");
  const booking = await managed(c, c.req.query("token"));
  const loaded = (await loadEventType(ctx.db, booking.eventTypeId))!;
  const hosts = await bookingHostsOf(ctx, [booking.id]);
  const owner = loaded.eventType.teamId
    ? { kind: "team" as const, ...(await ctx.db.select({ name: teams.name, slug: teams.slug }).from(teams).where(eq(teams.id, loaded.eventType.teamId)))[0] }
    : { kind: "user" as const, ...(await ctx.db.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, loaded.eventType.ownerUserId!)))[0] };
  const canChange = booking.status === "confirmed" && booking.startAt.getTime() > Date.now();
  return c.json({
    org: await org(c),
    booking: serializeBooking(booking, { eventType: loaded.eventType, hosts: hosts.get(booking.id)?.map((h) => ({ ...h, email: "" })) }),
    eventType: publicEventType(loaded, owner),
    canCancel: canChange,
    canReschedule: canChange && loaded.eventType.active,
  });
});

publicRoutes.post("/bookings/:id/cancel", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(c, z.object({ token: z.string().min(1), reason: z.string().max(1000).optional() }));
  const booking = await managed(c, body.token);
  if (booking.startAt.getTime() <= Date.now()) throw conflict("Past bookings cannot be cancelled", "booking_in_past");
  const updated = await cancelBooking(ctx, booking, {
    by: "invitee",
    reason: body.reason,
    actor: { userId: null, label: `invitee:${booking.inviteeEmail}`, ip: clientIp(c) },
  });
  return c.json({ booking: serializeBooking(updated) });
});

publicRoutes.post("/bookings/:id/reschedule", async (c) => {
  limit(c, bookingLimiter);
  const ctx = c.get("ctx");
  const body = await parseBody(c, z.object({ token: z.string().min(1), start: z.string().datetime({ offset: true }), reason: z.string().max(1000).optional() }));
  const booking = await managed(c, body.token);
  if (booking.status !== "confirmed" || booking.startAt.getTime() <= Date.now()) throw conflict("This booking can no longer be rescheduled", "not_reschedulable");
  const { booking: next, manageToken } = await createBooking(ctx, {
    eventTypeId: booking.eventTypeId,
    start: new Date(body.start),
    invitee: { name: booking.inviteeName, email: booking.inviteeEmail, timezone: booking.inviteeTimezone, answers: booking.answers },
    actor: { userId: null, label: `invitee:${booking.inviteeEmail}`, ip: clientIp(c) },
    reschedule: { booking, by: "invitee", reason: body.reason },
  });
  return c.json({ booking: serializeBooking(next), manageToken }, 201);
});
