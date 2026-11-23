import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "@timebook/core";
import { actor, currentUser, requireSession, type AppEnv } from "../auth/middleware";
import { apiKeys, users, webhookDeliveries, webhooks } from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { conflict, forbidden, notFound, parseBody } from "../lib/http";
import { RESERVED_USERNAMES, SLUG_RE } from "../lib/slug";
import { audit } from "../services/audit";
import { publicUser } from "../services/users";
import { deliverWebhook, postWebhook, signatureHeader, validateWebhookUrl, WEBHOOK_EVENTS } from "../services/webhooks";
import { isAdmin } from "../auth/middleware";

/** /api/v1/me */
export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/", (c) => c.json({ user: publicUser(currentUser(c)) }));

meRoutes.patch("/", async (c) => {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(
    c,
    z.object({
      name: z.string().min(1).max(120).optional(),
      timezone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
      username: z
        .string()
        .regex(SLUG_RE, "Use lowercase letters, digits and dashes")
        .refine((u) => !RESERVED_USERNAMES.has(u), "That username is reserved")
        .optional(),
      welcomeMessage: z.string().max(1000).nullable().optional(),
    }),
  );
  if (Object.keys(body).length === 0) return c.json({ user: publicUser(user) });
  if (body.username && body.username !== user.username) {
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.username, body.username));
    if (taken) throw conflict("That username is taken", "username_taken");
  }
  const [updated] = await db.update(users).set(body).where(eq(users.id, user.id)).returning();
  await audit(db, actor(c), "user.profile_updated", { type: "user", id: user.id }, { fields: Object.keys(body) });
  return c.json({ user: publicUser(updated) });
});

/** /api/v1/users: directory for picking hosts and team members. */
export const directoryRoutes = new Hono<AppEnv>();
directoryRoutes.get("/", async (c) => {
  const { db } = c.get("ctx");
  currentUser(c);
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, username: users.username })
    .from(users)
    .where(isNull(users.disabledAt))
    .orderBy(users.name);
  return c.json({ users: rows });
});

/** /api/v1/api-keys */
export const apiKeyRoutes = new Hono<AppEnv>();

apiKeyRoutes.get("/", async (c) => {
  const { db } = c.get("ctx");
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, currentUser(c).id), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
  return c.json({ apiKeys: rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt })) });
});

apiKeyRoutes.post("/", async (c) => {
  requireSession(c);
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(c, z.object({ name: z.string().min(1).max(100) }));
  const key = `sk_${randomToken(32)}`;
  const prefix = key.slice(0, 10);
  const [row] = await db.insert(apiKeys).values({ userId: user.id, name: body.name, prefix, keyHash: sha256(key) }).returning();
  await audit(db, actor(c), "api_key.created", { type: "api_key", id: row.id }, { name: body.name, prefix });
  return c.json({ apiKey: { id: row.id, name: row.name, prefix, createdAt: row.createdAt }, secret: key }, 201);
});

apiKeyRoutes.delete("/:id", async (c) => {
  const { db } = c.get("ctx");
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, currentUser(c).id)))
    .returning();
  if (!row) throw notFound("API key not found");
  await audit(db, actor(c), "api_key.revoked", { type: "api_key", id });
  return c.json({ ok: true });
});

/** /api/v1/webhooks */
export const webhookRoutes = new Hono<AppEnv>();

const webhookInput = z.object({
  url: z.string().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS as [string, ...string[]])).min(1),
  scope: z.enum(["user", "org"]).default("user"),
  active: z.boolean().default(true),
});

function serializeWebhook(w: typeof webhooks.$inferSelect) {
  return { id: w.id, url: w.url, events: w.events, scope: w.scope, active: w.active, createdAt: w.createdAt };
}

async function ownWebhook(c: Context<AppEnv>) {
  const { db } = c.get("ctx");
  const id = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) throw notFound("Webhook not found");
  const [w] = await db.select().from(webhooks).where(eq(webhooks.id, id));
  const user = currentUser(c);
  if (!w || (w.userId !== user.id && !(w.scope === "org" && isAdmin(user)))) throw notFound("Webhook not found");
  return w;
}

webhookRoutes.get("/", async (c) => {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  const rows = await db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
  return c.json({ webhooks: rows.filter((w) => w.userId === user.id || (w.scope === "org" && isAdmin(user))).map(serializeWebhook) });
});

webhookRoutes.post("/", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(c, webhookInput);
  if (body.scope === "org" && !isAdmin(user)) throw forbidden("Only admins can create organization-wide webhooks");
  const url = await validateWebhookUrl(ctx, body.url);
  const secret = `whsec_${randomToken(24)}`;
  const [row] = await ctx.db
    .insert(webhooks)
    .values({ userId: user.id, url, events: body.events as never, scope: body.scope, active: body.active, secretEnc: ctx.encrypter.encrypt(secret) })
    .returning();
  await audit(ctx.db, actor(c), "webhook.created", { type: "webhook", id: row.id }, { url, events: body.events, scope: body.scope });
  return c.json({ webhook: serializeWebhook(row), secret }, 201);
});

webhookRoutes.patch("/:id", async (c) => {
  const ctx = c.get("ctx");
  const { db } = ctx;
  const w = await ownWebhook(c);
  const body = await parseBody(c, webhookInput.omit({ scope: true }).partial());
  const [row] = await db
    .update(webhooks)
    .set({ url: body.url ? await validateWebhookUrl(ctx, body.url) : w.url, ...(body.events ? { events: body.events as never } : {}), ...(body.active !== undefined ? { active: body.active } : {}) })
    .where(eq(webhooks.id, w.id))
    .returning();
  await audit(db, actor(c), "webhook.updated", { type: "webhook", id: w.id }, { fields: Object.keys(body) });
  return c.json({ webhook: serializeWebhook(row) });
});

webhookRoutes.delete("/:id", async (c) => {
  const { db } = c.get("ctx");
  const w = await ownWebhook(c);
  await db.delete(webhooks).where(eq(webhooks.id, w.id));
  await audit(db, actor(c), "webhook.deleted", { type: "webhook", id: w.id });
  return c.json({ ok: true });
});

webhookRoutes.get("/:id/deliveries", async (c) => {
  const { db } = c.get("ctx");
  const w = await ownWebhook(c);
  const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, w.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50);
  return c.json({
    deliveries: rows.map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, responseStatus: d.responseStatus, lastError: d.lastError, createdAt: d.createdAt, deliveredAt: d.deliveredAt })),
  });
});

/** Send a signed test ping right now and report the response. */
webhookRoutes.post("/:id/test", async (c) => {
  const ctx = c.get("ctx");
  const w = await ownWebhook(c);
  const body = JSON.stringify({ id: `ping_${randomToken(8)}`, event: "ping", createdAt: new Date().toISOString(), data: {} });
  try {
    const res = await postWebhook(ctx, w.url, { "x-webhook-event": "ping", "x-webhook-signature": signatureHeader(ctx.encrypter.decrypt(w.secretEnc), body) }, body);
    return c.json({ ok: res.ok, status: res.status });
  } catch (err) {
    return c.json({ ok: false, status: null, error: err instanceof Error ? err.message : String(err) });
  }
});

webhookRoutes.post("/:id/deliveries/:deliveryId/retry", async (c) => {
  const ctx = c.get("ctx");
  const w = await ownWebhook(c);
  const deliveryId = c.req.param("deliveryId");
  if (!z.string().uuid().safeParse(deliveryId).success) throw notFound("Delivery not found");
  const [delivery] = await ctx.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, w.id)));
  if (!delivery) throw notFound("Delivery not found");
  try {
    await deliverWebhook(ctx, delivery.id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
