import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "@timebook/core";
import { buildOidcLogin, completeOidcLogin } from "../auth/oidc";
import { actor, clientIp, createSession, currentUser, destroySession, SESSION_COOKIE, type AppEnv } from "../auth/middleware";
import { authTokens, oauthStates, orgSettings, sessions, users } from "../db/schema";
import { hashPassword, sha256, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound, parseBody } from "../lib/http";
import { RateLimiter } from "../lib/rateLimit";
import { audit } from "../services/audit";
import { createUser, getOrgSettings, publicUser, userCount } from "../services/users";

const loginLimiter = new RateLimiter(10, 15 * 60_000);
const password = z.string().min(10, "Use at least 10 characters").max(200);
const timezone = z.string().refine(isValidTimeZone, "Unknown time zone");

/** Only same-site paths: "/app/x" is fine, "//evil.com" and "/\\evil.com" are not. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  return value;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/status", async (c) => {
  const ctx = c.get("ctx");
  const user = c.get("user");
  const org = await getOrgSettings(ctx.db);
  return c.json({
    appName: ctx.config.APP_NAME,
    orgName: org.name,
    brandColor: org.brandColor,
    setupRequired: (await userCount(ctx.db)) === 0,
    passwordLogin: ctx.config.PASSWORD_LOGIN,
    oidc: { enabled: ctx.config.oidcEnabled, name: ctx.config.OIDC_DISPLAY_NAME, provider: ctx.config.oidcProvider },
    integrations: ctx.calendars.available(),
    user: user ? publicUser(user) : null,
  });
});

authRoutes.post("/setup", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(
    c,
    z.object({ name: z.string().min(1).max(120), email: z.string().email(), password, timezone, orgName: z.string().min(1).max(120) }),
  );
  if ((await userCount(ctx.db)) > 0) throw conflict("Setup is already complete", "setup_complete");
  let user;
  try {
    user = await createUser(ctx.db, {
      email: body.email,
      name: body.name,
      role: "owner",
      timezone: body.timezone,
      passwordHash: await hashPassword(body.password),
    });
  } catch {
    // The unique owner index rejects a second concurrent setup.
    throw conflict("Setup is already complete", "setup_complete");
  }
  await getOrgSettings(ctx.db);
  await ctx.db.update(orgSettings).set({ name: body.orgName, updatedAt: new Date() }).where(eq(orgSettings.id, 1));
  await createSession(c, user.id);
  await audit(ctx.db, { userId: user.id, label: user.email, ip: clientIp(c) }, "org.setup", { type: "user", id: user.id });
  return c.json({ user: publicUser(user) }, 201);
});

authRoutes.post("/login", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(c, z.object({ email: z.string().email(), password: z.string().min(1) }));
  const email = body.email.toLowerCase();
  if (!loginLimiter.check(`${clientIp(c)}:${email}`)) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.");
  const [user] = await ctx.db.select().from(users).where(eq(users.email, email));
  const ok = user && !user.disabledAt && (await verifyPassword(body.password, user.passwordHash));
  if (!ok) {
    await audit(ctx.db, { userId: user?.id ?? null, label: email, ip: clientIp(c) }, "auth.login_failed");
    throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
  }
  if (!ctx.config.PASSWORD_LOGIN && user.role !== "owner") throw forbidden("Password sign-in is disabled. Use single sign-on.");
  await createSession(c, user.id);
  await audit(ctx.db, { userId: user.id, label: user.email, ip: clientIp(c) }, "auth.login", undefined, { method: "password" });
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get("/oidc/start", async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.config.oidcEnabled) throw notFound("Single sign-on is not configured");
  const login = await buildOidcLogin(ctx.config);
  await ctx.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await ctx.db.insert(oauthStates).values({
    state: login.state,
    provider: "oidc",
    codeVerifier: login.codeVerifier,
    nonce: login.nonce,
    returnTo: safeReturnTo(c.req.query("returnTo")),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return c.redirect(login.url);
});

authRoutes.get("/oidc/callback", async (c) => {
  const ctx = c.get("ctx");
  const state = c.req.query("state");
  if (!state) throw badRequest("Missing state");
  const [saved] = await ctx.db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.provider, "oidc"), gt(oauthStates.expiresAt, new Date())));
  if (!saved) return c.redirect("/login?error=sso_expired");
  await ctx.db.delete(oauthStates).where(eq(oauthStates.state, state));

  const currentUrl = new URL(c.req.url);
  const publicUrl = new URL(`${ctx.config.APP_URL}/api/auth/oidc/callback${currentUrl.search}`);
  let identity;
  try {
    identity = await completeOidcLogin(ctx.config, publicUrl, saved);
  } catch (err) {
    console.warn("[oidc]", err);
    return c.redirect("/login?error=sso_failed");
  }

  const resolved = await resolveSsoUser(ctx, identity, clientIp(c));
  if ("error" in resolved) return c.redirect(`/login?error=${resolved.error}`);
  const user = resolved.user;
  if (user.disabledAt) return c.redirect("/login?error=account_disabled");
  await createSession(c, user.id);
  await audit(ctx.db, { userId: user.id, label: user.email, ip: clientIp(c) }, "auth.login", undefined, { method: "oidc" });
  return c.redirect(saved.returnTo ?? "/app");
});

export interface SsoIdentity {
  subject: string;
  email: string;
  name: string;
  /** True only when the identity provider asserted `email_verified: true`. */
  emailVerified: boolean;
}

/**
 * Map an identity-provider login to a local account.
 * 1. Match the IdP subject. 2. Otherwise match email, but only for accounts not linked to another subject
 * (a reassigned address must not take over someone's account). 3. Otherwise auto-provision if allowed.
 * Steps 2 and 3 trust the email address, so they require a verified email and an allowed domain.
 */
export async function resolveSsoUser(
  ctx: AppEnv["Variables"]["ctx"],
  identity: SsoIdentity,
  ip: string | null = null,
): Promise<{ user: typeof users.$inferSelect } | { error: "sso_account_conflict" | "sso_not_allowed" | "sso_email_unverified" }> {
  const email = identity.email.toLowerCase();
  const [bySubject] = await ctx.db.select().from(users).where(eq(users.oidcSubject, identity.subject));
  if (bySubject) return { user: bySubject };

  if (!identity.emailVerified && !ctx.config.OIDC_TRUST_UNVERIFIED_EMAIL) {
    await audit(ctx.db, { userId: null, label: email, ip }, "auth.login_failed", undefined, { method: "oidc", reason: "email_unverified" });
    return { error: "sso_email_unverified" };
  }
  const domain = email.split("@")[1];
  const domainOk = ctx.config.allowedEmailDomains.length === 0 || ctx.config.allowedEmailDomains.includes(domain);
  if (!domainOk) return { error: "sso_not_allowed" };

  const [byEmail] = await ctx.db.select().from(users).where(eq(users.email, email));
  if (byEmail) {
    if (byEmail.oidcSubject && byEmail.oidcSubject !== identity.subject) {
      await audit(ctx.db, { userId: null, label: email, ip }, "auth.login_failed", { type: "user", id: byEmail.id }, { method: "oidc", reason: "subject_mismatch" });
      return { error: "sso_account_conflict" };
    }
    await ctx.db.update(users).set({ oidcSubject: identity.subject }).where(eq(users.id, byEmail.id));
    return { user: { ...byEmail, oidcSubject: identity.subject } };
  }

  if (!ctx.config.OIDC_AUTO_PROVISION) return { error: "sso_not_allowed" };
  const user = await createUser(ctx.db, { email, name: identity.name, oidcSubject: identity.subject });
  await audit(ctx.db, { userId: user.id, label: user.email, ip }, "user.provisioned", { type: "user", id: user.id }, { via: "oidc" });
  return { user };
}

async function findToken(c: { get: (k: "ctx") => AppEnv["Variables"]["ctx"] }, token: string) {
  const ctx = c.get("ctx");
  const [row] = await ctx.db
    .select({ token: authTokens, user: users })
    .from(authTokens)
    .innerJoin(users, eq(authTokens.userId, users.id))
    .where(and(eq(authTokens.id, sha256(token)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())));
  return row;
}

authRoutes.get("/invite/:token", async (c) => {
  const row = await findToken(c, c.req.param("token"));
  if (!row) throw notFound("This invite link is invalid or has expired");
  return c.json({ email: row.user.email, name: row.user.name, purpose: row.token.purpose });
});

authRoutes.post("/invite/:token", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(c, z.object({ password, name: z.string().min(1).max(120).optional(), timezone: timezone.optional() }));
  const row = await findToken(c, c.req.param("token"));
  if (!row) throw notFound("This invite link is invalid or has expired");
  await ctx.db
    .update(users)
    .set({
      passwordHash: await hashPassword(body.password),
      ...(body.name ? { name: body.name } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
    })
    .where(eq(users.id, row.user.id));
  await ctx.db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.token.id));
  await createSession(c, row.user.id);
  await audit(ctx.db, { userId: row.user.id, label: row.user.email, ip: clientIp(c) }, `auth.${row.token.purpose}_accepted`);
  return c.json({ ok: true });
});

authRoutes.post("/password", async (c) => {
  const ctx = c.get("ctx");
  const user = currentUser(c);
  const body = await parseBody(c, z.object({ currentPassword: z.string().optional(), newPassword: password }));
  if (user.passwordHash && !(await verifyPassword(body.currentPassword ?? "", user.passwordHash))) {
    throw new HttpError(400, "invalid_credentials", "Current password is incorrect");
  }
  await ctx.db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, user.id));
  // Sign out every other session.
  const token = getCookie(c, SESSION_COOKIE);
  await ctx.db.delete(sessions).where(and(eq(sessions.userId, user.id), token ? ne(sessions.id, sha256(token)) : undefined));
  await audit(ctx.db, actor(c), "auth.password_changed", { type: "user", id: user.id });
  return c.json({ ok: true });
});
