import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "@scheduler/core";
import { actor, currentUser, isAdmin, type AppEnv } from "../auth/middleware";
import type { Db } from "../db";
import { eventTypeHosts, eventTypes, schedules, teamMembers, users } from "../db/schema";
import { badRequest, conflict, forbidden, notFound, parseBody, parseQuery } from "../lib/http";
import { SLUG_RE, slugify } from "../lib/slug";
import { audit } from "../services/audit";
import { getSlots, loadEventType, MAX_RANGE_DAYS, type EventTypeRow } from "../services/availability";
import { canManageEventType, canViewEventType, teamRole } from "../services/permissions";
import { serializeEventType } from "../services/serialize";

const minutes = (max: number) => z.number().int().min(0).max(max);

const questionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/, "Use lowercase letters, digits and underscores"),
  label: z.string().min(1).max(300),
  type: z.enum(["text", "textarea", "phone", "select", "checkbox"]),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
});

const hostSchema = z.object({
  userId: z.string().uuid(),
  priority: z.number().int().min(0).max(10).default(0),
  weight: z.number().int().min(1).max(100).default(1),
  scheduleId: z.string().uuid().nullable().optional(),
});

const bookingWindowSchema = z
  .union([
    z.object({ type: z.literal("rolling"), days: z.number().int().min(0).max(730) }),
    z.object({ type: z.literal("range"), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  ])
  .nullable();

const fields = {
  title: z.string().min(1).max(200),
  slug: z.string().regex(SLUG_RE, "Use lowercase letters, digits and dashes"),
  description: z.string().max(5000),
  kind: z.enum(["one_on_one", "group", "collective", "round_robin"]),
  teamId: z.string().uuid().nullable(),
  durationMinutes: z.number().int().min(5).max(720),
  slotIntervalMinutes: z.number().int().min(5).max(720).nullable(),
  bufferBeforeMinutes: minutes(720),
  bufferAfterMinutes: minutes(720),
  minimumNoticeMinutes: minutes(60 * 24 * 90),
  bookingWindow: bookingWindowSchema,
  dailyLimit: z.number().int().min(1).max(200).nullable(),
  weeklyLimit: z.number().int().min(1).max(1000).nullable(),
  seats: z.number().int().min(2).max(1000).nullable(),
  location: z
    .object({
      type: z.enum(["google_meet", "microsoft_teams", "link", "phone", "in_person", "custom"]),
      value: z.string().max(1000).optional(),
    })
    .refine((l) => l.type !== "link" || !l.value || /^https?:\/\//i.test(l.value), "Meeting links must start with http:// or https://"),
  questions: z.array(questionSchema).max(25),
  reminderMinutes: z.array(z.number().int().min(5).max(60 * 24 * 14)).max(5),
  rrStrategy: z.enum(["maximize_availability", "equal_distribution"]),
  rrMaxImbalance: z.number().int().min(1).max(100).nullable(),
  redirectUrl: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) URL").nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  hidden: z.boolean(),
  active: z.boolean(),
  hosts: z.array(hostSchema).max(100),
};

const createSchema = z.object({
  ...fields,
  slug: fields.slug.optional(),
  description: fields.description.default(""),
  kind: fields.kind.default("one_on_one"),
  teamId: fields.teamId.optional(),
  durationMinutes: fields.durationMinutes.default(30),
  slotIntervalMinutes: fields.slotIntervalMinutes.optional(),
  bufferBeforeMinutes: fields.bufferBeforeMinutes.default(0),
  bufferAfterMinutes: fields.bufferAfterMinutes.default(0),
  minimumNoticeMinutes: fields.minimumNoticeMinutes.default(240),
  bookingWindow: fields.bookingWindow.optional(),
  dailyLimit: fields.dailyLimit.optional(),
  weeklyLimit: fields.weeklyLimit.optional(),
  seats: fields.seats.optional(),
  location: fields.location.default({ type: "link" }),
  questions: fields.questions.default([]),
  reminderMinutes: fields.reminderMinutes.default([1440, 60]),
  rrStrategy: fields.rrStrategy.default("maximize_availability"),
  rrMaxImbalance: fields.rrMaxImbalance.optional(),
  redirectUrl: fields.redirectUrl.optional(),
  color: fields.color.default("#2563eb"),
  hidden: fields.hidden.default(false),
  active: fields.active.default(true),
  hosts: fields.hosts.optional(),
});
const updateSchema = z.object(fields).partial();

type HostInput = z.infer<typeof hostSchema>;

async function validateHosts(db: Db, hosts: HostInput[], teamId: string | null, actor?: { id: string; admin: boolean; ownerUserId: string | null }) {
  // People's time is only bookable with consent: outside a team, only admins can add other hosts.
  if (!teamId && actor && !actor.admin && hosts.some((h) => h.userId !== actor.ownerUserId)) {
    throw forbidden("To schedule other people, create the event type under a team they belong to");
  }
  const ids = [...new Set(hosts.map((h) => h.userId))];
  if (ids.length !== hosts.length) throw badRequest("Each host can only be listed once");
  if (ids.length === 0) return;
  const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
  if (found.length !== ids.length) throw badRequest("One or more hosts do not exist");
  if (teamId) {
    const members = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.userId, ids)));
    if (members.length !== ids.length) throw badRequest("Team event hosts must be members of the team");
  }
  for (const h of hosts) {
    if (!h.scheduleId) continue;
    const [s] = await db.select().from(schedules).where(and(eq(schedules.id, h.scheduleId), eq(schedules.userId, h.userId)));
    if (!s) throw badRequest("A host schedule does not belong to that host");
  }
}

function checkKindRules(et: Pick<EventTypeRow, "kind" | "seats" | "ownerUserId">, hostCount: number) {
  if (et.kind === "group" && !et.seats) throw badRequest("Group events need a seat count (2 or more)");
  if (et.kind === "collective" && hostCount < 2) throw badRequest("Collective events need at least two hosts");
  if (et.kind === "round_robin" && hostCount < 1) throw badRequest("Round-robin events need at least one host");
  if ((et.kind === "one_on_one" || et.kind === "group") && hostCount > 1) throw badRequest("One-on-one and group events have a single host");
  if (!et.ownerUserId && hostCount === 0) throw badRequest("Team events need at least one host");
}

async function replaceHosts(db: Db, eventTypeId: string, hosts: HostInput[]) {
  await db.delete(eventTypeHosts).where(eq(eventTypeHosts.eventTypeId, eventTypeId));
  if (hosts.length) {
    await db.insert(eventTypeHosts).values(
      hosts.map((h) => ({ eventTypeId, userId: h.userId, priority: h.priority, weight: h.weight, scheduleId: h.scheduleId ?? null })),
    );
  }
}

async function load(db: Db, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Event type not found");
  const loaded = await loadEventType(db, id);
  if (!loaded) throw notFound("Event type not found");
  return loaded;
}

function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** 404 when the caller cannot even see the event type (no enumeration), 403 when they can see but not edit it. */
async function assertCanManage(db: Db, user: Parameters<typeof canManageEventType>[1], et: EventTypeRow) {
  if (await canManageEventType(db, user, et)) return;
  if (await canViewEventType(db, user, et)) throw forbidden("Only the owner, team managers and admins can change this event type");
  throw notFound("Event type not found");
}

export const eventTypeRoutes = new Hono<AppEnv>();

eventTypeRoutes.get("/", async (c) => {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const { scope } = parseQuery(c, z.object({ scope: z.enum(["mine", "all"]).default("mine") }));
  let rows: EventTypeRow[];
  if (scope === "all" && isAdmin(user)) {
    rows = await db.select().from(eventTypes).orderBy(eventTypes.createdAt);
  } else {
    const myTeams = (await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, user.id))).map((t) => t.teamId);
    const hosted = (await db.select({ id: eventTypeHosts.eventTypeId }).from(eventTypeHosts).where(eq(eventTypeHosts.userId, user.id))).map((h) => h.id);
    rows = await db
      .select()
      .from(eventTypes)
      .where(
        or(
          eq(eventTypes.ownerUserId, user.id),
          myTeams.length ? and(isNotNull(eventTypes.teamId), inArray(eventTypes.teamId, myTeams)) : undefined,
          hosted.length ? inArray(eventTypes.id, hosted) : undefined,
        ),
      )
      .orderBy(eventTypes.createdAt);
  }
  const hosts = rows.length
    ? await db
        .select({ h: eventTypeHosts, name: users.name, email: users.email })
        .from(eventTypeHosts)
        .innerJoin(users, eq(eventTypeHosts.userId, users.id))
        .where(inArray(eventTypeHosts.eventTypeId, rows.map((r) => r.id)))
    : [];
  return c.json({
    eventTypes: rows.map((et) =>
      serializeEventType(
        et,
        hosts.filter((h) => h.h.eventTypeId === et.id).map((h) => ({ userId: h.h.userId, priority: h.h.priority, weight: h.h.weight, scheduleId: h.h.scheduleId, name: h.name, email: h.email })),
      ),
    ),
  });
});

eventTypeRoutes.post("/", async (c) => {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(c, createSchema);
  const teamId = body.teamId ?? null;
  if (teamId && !isAdmin(user) && (await teamRole(db, user.id, teamId)) !== "manager") {
    throw forbidden("Only team managers and admins can create team event types");
  }
  const hosts = body.hosts ?? [];
  const ownerUserId = teamId ? null : user.id;
  await validateHosts(db, hosts, teamId, { id: user.id, admin: isAdmin(user), ownerUserId });
  const hostCount = hosts.length || (ownerUserId ? 1 : 0);
  checkKindRules({ kind: body.kind, seats: body.seats ?? null, ownerUserId }, hostCount);
  const { hosts: _h, teamId: _t, ...values } = body;
  try {
    const created = await db.transaction(async (tx) => {
      const [et] = await tx
        .insert(eventTypes)
        .values({ ...values, slug: body.slug ?? (slugify(body.title) || "meeting"), ownerUserId, teamId })
        .returning();
      await replaceHosts(tx, et.id, hosts);
      return et;
    });
    await audit(db, actor(c), "event_type.created", { type: "event_type", id: created.id }, { title: created.title, kind: created.kind });
    return c.json({ eventType: serializeEventType(created, (await loadEventType(db, created.id))!.hosts) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("An event type with this URL slug already exists", "slug_taken");
    throw err;
  }
});

eventTypeRoutes.get("/:id", async (c) => {
  const { db } = c.get("ctx");
  const loaded = await load(db, c.req.param("id"));
  if (!(await canViewEventType(db, currentUser(c), loaded.eventType))) throw notFound("Event type not found");
  return c.json({ eventType: serializeEventType(loaded.eventType, loaded.hosts) });
});

eventTypeRoutes.patch("/:id", async (c) => {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const loaded = await load(db, c.req.param("id"));
  const et = loaded.eventType;
  await assertCanManage(db, user, et);
  const body = await parseBody(c, updateSchema);
  if (body.teamId !== undefined && body.teamId !== et.teamId) throw badRequest("Moving an event type between owners is not supported yet");
  const { hosts, teamId: _t, ...values } = body;
  if (hosts) await validateHosts(db, hosts, et.teamId, { id: user.id, admin: isAdmin(user), ownerUserId: et.ownerUserId });
  const next = { ...et, ...values };
  const hostCount = hosts ? hosts.length || (et.ownerUserId ? 1 : 0) : loaded.hosts.length;
  checkKindRules(next, hostCount);
  try {
    await db.transaction(async (tx) => {
      await tx.update(eventTypes).set({ ...values, updatedAt: new Date() }).where(eq(eventTypes.id, et.id));
      if (hosts) await replaceHosts(tx, et.id, hosts);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("An event type with this URL slug already exists", "slug_taken");
    throw err;
  }
  await audit(db, actor(c), "event_type.updated", { type: "event_type", id: et.id }, { fields: Object.keys(body) });
  const reloaded = (await loadEventType(db, et.id))!;
  return c.json({ eventType: serializeEventType(reloaded.eventType, reloaded.hosts) });
});

eventTypeRoutes.delete("/:id", async (c) => {
  const { db } = c.get("ctx");
  const loaded = await load(db, c.req.param("id"));
  await assertCanManage(db, currentUser(c), loaded.eventType);
  // Soft-delete keeps booking history intact.
  await db.update(eventTypes).set({ active: false, hidden: true, slug: `${loaded.eventType.slug}-deleted-${Date.now()}`, updatedAt: new Date() }).where(eq(eventTypes.id, loaded.eventType.id));
  await audit(c.get("ctx").db, actor(c), "event_type.deleted", { type: "event_type", id: loaded.eventType.id });
  return c.json({ ok: true });
});

export const slotsQuery = z.object({
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  timezone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
  debug: z.enum(["true", "false", "1", "0"]).optional(),
});

export function parseRange(q: { start: string; end: string }) {
  const from = new Date(q.start);
  const to = new Date(q.end);
  if (to <= from) throw badRequest("end must be after start");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw badRequest(`Range is limited to ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

/** Slots for any event type the caller can view. With debug=true, includes per-host reasons for blocked times. */
eventTypeRoutes.get("/:id/slots", async (c) => {
  const ctx = c.get("ctx");
  const loaded = await load(ctx.db, c.req.param("id"));
  if (!(await canViewEventType(ctx.db, currentUser(c), loaded.eventType))) throw notFound("Event type not found");
  const q = parseQuery(c, slotsQuery);
  const { from, to } = parseRange(q);
  const explain = q.debug === "true" || q.debug === "1";
  const result = await getSlots(ctx, loaded, from, to, { explain });
  const names = new Map(loaded.hosts.map((h) => [h.user.id, h.user.name]));
  return c.json({
    slots: result.slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), hostIds: s.hostIds, seatsRemaining: s.seatsRemaining })),
    explanations: result.explanations?.map((e) => ({
      start: new Date(e.start).toISOString(),
      available: e.available,
      hosts: e.hosts.map((h) => ({ ...h, name: names.get(h.hostId) })),
    })),
  });
});
