import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { actor, currentUser, isAdmin, requireAdmin, type AppEnv } from "../auth/middleware";
import type { AppContext } from "../context";
import { auditLog, authTokens, orgSettings, sessions, teamMembers, teams, users } from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound, parseBody, parseQuery } from "../lib/http";
import { SLUG_RE, slugify } from "../lib/slug";
import { audit } from "../services/audit";
import { sendInviteEmail } from "../services/notifications";
import { createUser, getOrgSettings, publicUser, type UserRow } from "../services/users";

async function issueInvite(ctx: AppContext, user: UserRow, invitedBy: string) {
  const token = randomToken(32);
  await ctx.db.insert(authTokens).values({ id: sha256(token), userId: user.id, purpose: "invite", expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  const url = `${ctx.config.APP_URL}/invite/${token}`;
  let emailed = true;
  try {
    await sendInviteEmail(ctx, user, url, invitedBy);
  } catch (err) {
    emailed = false;
    console.warn("[invite] email failed", err);
  }
  return { url, emailed };
}

/** /api/v1/admin */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

adminRoutes.get("/users", async (c) => {
  const { db } = c.get("ctx");
  const rows = await db.select().from(users).orderBy(users.createdAt);
  return c.json({ users: rows.map(publicUser) });
});

adminRoutes.post("/users", async (c) => {
  const ctx = c.get("ctx");
  const me = currentUser(c);
  const body = await parseBody(
    c,
    z.object({ email: z.string().email(), name: z.string().min(1).max(120), role: z.enum(["admin", "member"]).default("member"), timezone: z.string().optional() }),
  );
  const email = body.email.toLowerCase();
  const [exists] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (exists) throw conflict("A user with that email already exists", "email_taken");
  const user = await createUser(ctx.db, { email, name: body.name, role: body.role, timezone: body.timezone ?? me.timezone });
  const invite = await issueInvite(ctx, user, me.name);
  await audit(ctx.db, actor(c), "user.invited", { type: "user", id: user.id }, { email, role: body.role });
  return c.json({ user: publicUser(user), inviteUrl: invite.url, emailed: invite.emailed }, 201);
});

adminRoutes.post("/users/:id/invite", async (c) => {
  const ctx = c.get("ctx");
  const [user] = await ctx.db.select().from(users).where(eq(users.id, c.req.param("id")));
  if (!user) throw notFound("User not found");
  const invite = await issueInvite(ctx, user, currentUser(c).name);
  await audit(ctx.db, actor(c), "user.invite_resent", { type: "user", id: user.id });
  return c.json({ inviteUrl: invite.url, emailed: invite.emailed });
});

adminRoutes.patch("/users/:id", async (c) => {
  const ctx = c.get("ctx");
  const me = currentUser(c);
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  const body = await parseBody(c, z.object({ role: z.enum(["owner", "admin", "member"]).optional(), disabled: z.boolean().optional(), name: z.string().min(1).max(120).optional() }));
  const [user] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!user) throw notFound("User not found");
  if (user.role === "owner" && me.role !== "owner") throw forbidden("Only the owner can change the owner account");
  if (body.role === "owner" && me.role !== "owner") throw forbidden("Only the owner can transfer ownership");
  if (user.id === me.id && (body.disabled || (body.role && body.role !== me.role))) throw badRequest("You cannot change your own role or disable yourself");
  const changes: Partial<typeof users.$inferInsert> = {};
  if (body.name) changes.name = body.name;
  if (body.role) changes.role = body.role;
  if (body.disabled !== undefined) changes.disabledAt = body.disabled ? new Date() : null;
  await ctx.db.transaction(async (tx) => {
    if (body.role === "owner") await tx.update(users).set({ role: "admin" }).where(eq(users.id, me.id));
    await tx.update(users).set(changes).where(eq(users.id, id));
    if (body.disabled) await tx.delete(sessions).where(eq(sessions.userId, id));
  });
  await audit(ctx.db, actor(c), "user.updated", { type: "user", id }, body);
  const [updated] = await ctx.db.select().from(users).where(eq(users.id, id));
  return c.json({ user: publicUser(updated) });
});

adminRoutes.get("/audit", async (c) => {
  const { db } = c.get("ctx");
  const q = parseQuery(
    c,
    z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional(), action: z.string().max(100).optional() }),
  );
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(q.before ? lt(auditLog.id, q.before) : undefined, q.action ? sql`${auditLog.action} like ${q.action + "%"}` : undefined))
    .orderBy(desc(auditLog.id))
    .limit(q.limit);
  return c.json({ entries: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null });
});

/** CSV export for compliance archives and SIEM imports. */
adminRoutes.get("/audit.csv", async (c) => {
  const { db } = c.get("ctx");
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(50_000);
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "id,created_at,actor,actor_user_id,action,target_type,target_id,ip,metadata",
    ...rows.map((r) => [r.id, r.createdAt.toISOString(), r.actorLabel, r.actorUserId, r.action, r.targetType, r.targetId, r.ip, JSON.stringify(r.metadata)].map(cell).join(",")),
  ];
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="audit-log.csv"`);
  return c.body(lines.join("\n"));
});

adminRoutes.get("/org", async (c) => c.json({ org: await getOrgSettings(c.get("ctx").db) }));

adminRoutes.patch("/org", async (c) => {
  const { db } = c.get("ctx");
  const body = await parseBody(
    c,
    z.object({
      name: z.string().min(1).max(120).optional(),
      brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      logoUrl: z.string().url().max(2000).nullable().optional(),
    }),
  );
  await getOrgSettings(db);
  const [org] = await db.update(orgSettings).set({ ...body, updatedAt: new Date() }).where(eq(orgSettings.id, 1)).returning();
  await audit(db, actor(c), "org.updated", { type: "org", id: "1" }, body);
  return c.json({ org });
});

/** /api/v1/teams: everyone can list teams; admins create them; admins and team managers manage members. */
export const teamRoutes = new Hono<AppEnv>();

async function teamWithMembers(c: Context<AppEnv>, teamId: string) {
  const { db } = c.get("ctx");
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) return null;
  const members = await db
    .select({ userId: teamMembers.userId, role: teamMembers.role, name: users.name, email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
  return { ...team, members };
}

teamRoutes.get("/", async (c) => {
  const { db } = c.get("ctx");
  currentUser(c);
  const rows = await db.select().from(teams).orderBy(teams.name);
  const members = rows.length
    ? await db
        .select({ teamId: teamMembers.teamId, userId: teamMembers.userId, role: teamMembers.role, name: users.name, email: users.email })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(inArray(teamMembers.teamId, rows.map((t) => t.id)))
    : [];
  return c.json({ teams: rows.map((t) => ({ ...t, members: members.filter((m) => m.teamId === t.id).map(({ teamId: _, ...m }) => m) })) });
});

teamRoutes.post("/", async (c) => {
  const { db } = c.get("ctx");
  if (!isAdmin(currentUser(c))) throw forbidden("Only admins can create teams");
  const body = await parseBody(c, z.object({ name: z.string().min(1).max(120), slug: z.string().regex(SLUG_RE).optional() }));
  const slug = body.slug ?? slugify(body.name);
  const [taken] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug));
  if (taken) throw conflict("A team with that URL already exists", "slug_taken");
  const [team] = await db.insert(teams).values({ name: body.name, slug }).returning();
  await audit(db, actor(c), "team.created", { type: "team", id: team.id }, { name: team.name });
  return c.json({ team: { ...team, members: [] } }, 201);
});

async function canManageTeam(c: Context<AppEnv>, teamId: string) {
  const { db } = c.get("ctx");
  const user = currentUser(c);
  if (isAdmin(user)) return true;
  const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)));
  return m?.role === "manager";
}

teamRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  currentUser(c);
  const team = await teamWithMembers(c, id);
  if (!team) throw notFound("Team not found");
  return c.json({ team });
});

teamRoutes.patch("/:id", async (c) => {
  const { db } = c.get("ctx");
  const id = c.req.param("id");
  if (!(await canManageTeam(c, id))) throw forbidden();
  const body = await parseBody(c, z.object({ name: z.string().min(1).max(120).optional(), slug: z.string().regex(SLUG_RE).optional() }));
  try {
    await db.update(teams).set(body).where(eq(teams.id, id));
  } catch {
    throw conflict("A team with that URL already exists", "slug_taken");
  }
  await audit(db, actor(c), "team.updated", { type: "team", id }, body);
  return c.json({ team: await teamWithMembers(c, id) });
});

teamRoutes.put("/:id/members", async (c) => {
  const { db } = c.get("ctx");
  const id = c.req.param("id");
  if (!(await canManageTeam(c, id))) throw forbidden();
  const body = await parseBody(c, z.object({ members: z.array(z.object({ userId: z.string().uuid(), role: z.enum(["manager", "member"]).default("member") })).max(1000) }));
  await db.transaction(async (tx) => {
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, id));
    if (body.members.length) await tx.insert(teamMembers).values(body.members.map((m) => ({ teamId: id, userId: m.userId, role: m.role })));
  });
  await audit(db, actor(c), "team.members_updated", { type: "team", id }, { count: body.members.length });
  return c.json({ team: await teamWithMembers(c, id) });
});

teamRoutes.delete("/:id", async (c) => {
  const { db } = c.get("ctx");
  if (!isAdmin(currentUser(c))) throw forbidden("Only admins can delete teams");
  const id = c.req.param("id");
  const [team] = await db.delete(teams).where(eq(teams.id, id)).returning();
  if (!team) throw notFound("Team not found");
  await audit(db, actor(c), "team.deleted", { type: "team", id }, { name: team.name });
  return c.json({ ok: true });
});
