import { createHash } from "node:crypto";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actor, currentUser, type AppEnv } from "../auth/middleware";
import { calendarConnections, calendars, oauthStates } from "../db/schema";
import { randomToken } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { audit } from "../services/audit";

/** /api/v1/calendars: connected accounts and per-calendar settings. */
export const calendarRoutes = new Hono<AppEnv>();

calendarRoutes.get("/", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const conns = await ctx.db.select().from(calendarConnections).where(eq(calendarConnections.userId, user.id)).orderBy(calendarConnections.createdAt);
  const cals = await ctx.db.select().from(calendars).where(eq(calendars.userId, user.id));
  return c.json({
    available: ctx.calendars.available(),
    connections: conns.map((conn) => ({
      id: conn.id,
      provider: conn.provider,
      accountEmail: conn.accountEmail,
      lastError: conn.lastError,
      lastErrorAt: conn.lastErrorAt,
      createdAt: conn.createdAt,
      calendars: cals
        .filter((cal) => cal.connectionId === conn.id)
        .map((cal) => ({ id: cal.id, name: cal.name, checkConflicts: cal.checkConflicts, isDestination: cal.isDestination, readOnly: cal.readOnly })),
    })),
  });
});

calendarRoutes.patch("/:id", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  const body = await parseBody(c, z.object({ checkConflicts: z.boolean().optional(), isDestination: z.boolean().optional() }));
  const [cal] = await ctx.db.select().from(calendars).where(and(eq(calendars.id, id), eq(calendars.userId, user.id)));
  if (!cal) throw notFound("Calendar not found");
  if (Object.keys(body).length === 0) return c.json({ ok: true });
  if (body.isDestination && cal.readOnly) throw badRequest("Bookings cannot be written to a read-only calendar");
  await ctx.db.transaction(async (tx) => {
    if (body.isDestination) await tx.update(calendars).set({ isDestination: false }).where(and(eq(calendars.userId, user.id), ne(calendars.id, id)));
    await tx.update(calendars).set(body).where(eq(calendars.id, id));
  });
  ctx.calendars.clearCache();
  return c.json({ ok: true });
});

export const connectionRoutes = new Hono<AppEnv>();

connectionRoutes.post("/ics", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(c, z.object({ url: z.string().min(8).max(2000), name: z.string().min(1).max(100).default("Calendar feed") }));
  let url: URL;
  try {
    url = new URL(body.url.replace(/^webcal:\/\//i, "https://"));
  } catch {
    throw badRequest("Enter a valid calendar feed URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("Feed URL must be http(s) or webcal");
  try {
    const conn = await ctx.calendars.addIcsFeed(user.id, url.toString(), body.name);
    await audit(ctx.db, actor(c), "calendar.connected", { type: "calendar_connection", id: conn.id }, { provider: "ics" });
    return c.json({ id: conn.id }, 201);
  } catch (err) {
    throw badRequest(`Could not read that feed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

connectionRoutes.post("/:id/sync", async (c) => {
  const ctx = c.get("ctx");
  if (!z.string().uuid().safeParse(c.req.param("id")).success) throw notFound();
  const [conn] = await ctx.db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, c.req.param("id")), eq(calendarConnections.userId, currentUser(c).id)));
  if (!conn) throw notFound("Connection not found");
  if (conn.provider !== "ics") await ctx.calendars.syncCalendars(conn);
  ctx.calendars.clearCache();
  return c.json({ ok: true });
});

connectionRoutes.delete("/:id", async (c) => {
  const ctx = c.get("ctx");
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  const [conn] = await ctx.db
    .delete(calendarConnections)
    .where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, currentUser(c).id)))
    .returning();
  if (!conn) throw notFound("Connection not found");
  ctx.calendars.clearCache();
  await audit(ctx.db, actor(c), "calendar.disconnected", { type: "calendar_connection", id }, { provider: conn.provider });
  return c.json({ ok: true });
});

/** /api/integrations/:provider/start|callback: browser OAuth flow for Google and Microsoft calendars. */
export const integrationRoutes = new Hono<AppEnv>();

integrationRoutes.get("/:provider/start", async (c) => {
  const ctx = c.get("ctx");
  const user = c.get("user");
  if (!user) return c.redirect("/login?returnTo=/app/calendars");
  const providerId = c.req.param("provider");
  if (providerId !== "google" && providerId !== "microsoft") throw notFound();
  const provider = ctx.calendars.provider(providerId);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await ctx.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await ctx.db.insert(oauthStates).values({ state, provider: providerId, userId: user.id, codeVerifier: verifier, expiresAt: new Date(Date.now() + 10 * 60_000) });
  return c.redirect(provider.authorizeUrl({ state, codeChallenge: challenge, redirectUri: ctx.calendars.redirectUri(providerId) }));
});

integrationRoutes.get("/:provider/callback", async (c) => {
  const ctx = c.get("ctx");
  const providerId = c.req.param("provider");
  if (providerId !== "google" && providerId !== "microsoft") throw notFound();
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (c.req.query("error") || !state || !code) return c.redirect(`/app/calendars?error=${encodeURIComponent(c.req.query("error") ?? "missing_code")}`);
  const [saved] = await ctx.db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.provider, providerId), gt(oauthStates.expiresAt, new Date())));
  if (!saved || !saved.userId) return c.redirect("/app/calendars?error=expired");
  await ctx.db.delete(oauthStates).where(eq(oauthStates.state, state));
  const user = c.get("user");
  if (!user || user.id !== saved.userId) return c.redirect("/app/calendars?error=session_mismatch");
  try {
    const tokens = await ctx.calendars.provider(providerId).exchangeCode({ code, codeVerifier: saved.codeVerifier, redirectUri: ctx.calendars.redirectUri(providerId) });
    const conn = await ctx.calendars.connectOAuth(user.id, providerId, tokens);
    await audit(ctx.db, actor(c), "calendar.connected", { type: "calendar_connection", id: conn.id }, { provider: providerId, account: tokens.accountEmail });
    return c.redirect("/app/calendars?connected=" + providerId);
  } catch (err) {
    console.warn(`[calendar] ${providerId} connect failed`, err);
    return c.redirect("/app/calendars?error=connect_failed");
  }
});
