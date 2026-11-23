import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../context";
import { apiKeys, sessions, users } from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { forbidden, HttpError, unauthorized } from "../lib/http";
import type { UserRow } from "../services/users";

export const SESSION_COOKIE = "sched_session";

export type AppEnv = {
  Variables: {
    ctx: AppContext;
    user: UserRow | null;
    authMethod: "session" | "api_key" | null;
    actorLabel: string;
  };
};

export function clientIp(c: Context): string | null {
  const ctx = c.get("ctx") as AppContext;
  const hops = ctx.config.TRUST_PROXY;
  if (hops > 0) {
    // Each trusted proxy appends the address it received the request from, so the client is `hops`
    // entries from the right. Entries further left were written by the client and can be forged.
    const fwd = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
    if (fwd?.length) return fwd[Math.max(0, fwd.length - hops)];
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

export async function createSession(c: Context<AppEnv>, userId: string) {
  const ctx = c.get("ctx");
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_DAYS * 86_400_000);
  await ctx.db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: ctx.config.secureCookies,
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.get("ctx").db.delete(sessions).where(eq(sessions.id, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Resolve the caller from a Bearer API key or the session cookie. Never throws. */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = c.get("ctx");
  c.set("user", null);
  c.set("authMethod", null);
  c.set("actorLabel", "anonymous");

  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    const [row] = await ctx.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(and(eq(apiKeys.keyHash, sha256(key)), isNull(apiKeys.revokedAt)));
    if (!row || row.user.disabledAt) throw unauthorized("Invalid API key");
    c.set("user", row.user);
    c.set("authMethod", "api_key");
    c.set("actorLabel", `${row.user.email} (api key ${row.key.prefix})`);
    if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > 60_000) {
      await ctx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id));
    }
    return next();
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const [row] = await ctx.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
    if (row && !row.user.disabledAt) {
      c.set("user", row.user);
      c.set("authMethod", "session");
      c.set("actorLabel", row.user.email);
    }
  }
  return next();
};

/**
 * CSRF protection for cookie-authenticated writes: the browser must send JSON (which forces a CORS
 * preflight cross-origin) and, when present, an Origin header that matches this deployment.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (["GET", "HEAD", "OPTIONS"].includes(method) || c.get("authMethod") === "api_key") return next();
  const origin = c.req.header("origin");
  if (origin) {
    const expected = new URL(c.get("ctx").config.APP_URL).origin;
    const requestOrigin = new URL(c.req.url).origin;
    if (origin !== expected && origin !== requestOrigin) throw new HttpError(403, "csrf", "Cross-origin request rejected");
  }
  const contentType = c.req.header("content-type") ?? "";
  const hasBody = Number(c.req.header("content-length") ?? "0") > 0 || Boolean(c.req.header("transfer-encoding"));
  if (hasBody && !contentType.includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send JSON with Content-Type: application/json");
  }
  return next();
};

export function currentUser(c: Context<AppEnv>): UserRow {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}

export function isAdmin(user: UserRow) {
  return user.role === "owner" || user.role === "admin";
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  currentUser(c);
  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(currentUser(c))) throw forbidden("Admins only");
  return next();
};

export function requireSession(c: Context<AppEnv>) {
  if (c.get("authMethod") !== "session") throw forbidden("This action requires signing in through the web app");
}

export function actor(c: Context<AppEnv>) {
  const user = c.get("user");
  return { userId: user?.id ?? null, label: c.get("actorLabel"), ip: clientIp(c) };
}
