import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { isValidTimeZone, validateSchedule } from "@scheduler/core";
import { actor, currentUser, type AppEnv } from "../auth/middleware";
import { schedules } from "../db/schema";
import { badRequest, conflict, notFound, parseBody } from "../lib/http";
import { audit } from "../services/audit";
import { serializeSchedule } from "../services/serialize";

const range = z.object({ start: z.string(), end: z.string() });
const scheduleFields = {
  name: z.string().min(1).max(120),
  timezone: z.string().refine(isValidTimeZone, "Unknown time zone"),
  weekly: z.array(z.object({ day: z.number().int().min(1).max(7), ranges: z.array(range).max(12) })).max(7),
  overrides: z.array(z.object({ date: z.string(), ranges: z.array(range).max(12) })).max(500),
  isDefault: z.boolean(),
};

function check(input: { timezone: string; weekly: { day: number; ranges: { start: string; end: string }[] }[]; overrides: { date: string; ranges: { start: string; end: string }[] }[] }) {
  const errors = validateSchedule(input as Parameters<typeof validateSchedule>[0]);
  if (errors.length) throw badRequest("Invalid schedule", errors.map((message) => ({ path: "schedule", message })));
}

export const scheduleRoutes = new Hono<AppEnv>();

scheduleRoutes.get("/", async (c) => {
  const { db } = c.get("ctx");
  const rows = await db.select().from(schedules).where(eq(schedules.userId, currentUser(c).id)).orderBy(schedules.createdAt);
  return c.json({ schedules: rows.map(serializeSchedule) });
});

scheduleRoutes.post("/", async (c) => {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(c, z.object({ ...scheduleFields, overrides: scheduleFields.overrides.default([]), isDefault: scheduleFields.isDefault.default(false) }));
  check(body);
  const created = await db.transaction(async (tx) => {
    if (body.isDefault) await tx.update(schedules).set({ isDefault: false }).where(eq(schedules.userId, user.id));
    const [s] = await tx.insert(schedules).values({ ...body, weekly: body.weekly as never, userId: user.id }).returning();
    return s;
  });
  await audit(db, actor(c), "schedule.created", { type: "schedule", id: created.id });
  return c.json({ schedule: serializeSchedule(created) }, 201);
});

async function own(c: Context<AppEnv>) {
  const { db } = c.get("ctx");
  const id = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) throw notFound("Schedule not found");
  const [s] = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.userId, currentUser(c).id)));
  if (!s) throw notFound("Schedule not found");
  return s;
}

scheduleRoutes.patch("/:id", async (c) => {
  const { db } = c.get("ctx");
  const s = await own(c);
  const body = await parseBody(c, z.object(scheduleFields).partial());
  check({ timezone: body.timezone ?? s.timezone, weekly: body.weekly ?? s.weekly, overrides: body.overrides ?? s.overrides });
  if (body.isDefault === false && s.isDefault) throw badRequest("Make another schedule the default instead");
  const updated = await db.transaction(async (tx) => {
    if (body.isDefault) await tx.update(schedules).set({ isDefault: false }).where(eq(schedules.userId, s.userId));
    const [u] = await tx.update(schedules).set({ ...body, weekly: body.weekly as never }).where(eq(schedules.id, s.id)).returning();
    return u;
  });
  await audit(db, actor(c), "schedule.updated", { type: "schedule", id: s.id });
  return c.json({ schedule: serializeSchedule(updated) });
});

scheduleRoutes.delete("/:id", async (c) => {
  const { db } = c.get("ctx");
  const s = await own(c);
  if (s.isDefault) throw conflict("You cannot delete your default schedule", "default_schedule");
  await db.delete(schedules).where(eq(schedules.id, s.id));
  await audit(db, actor(c), "schedule.deleted", { type: "schedule", id: s.id });
  return c.json({ ok: true });
});
