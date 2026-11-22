import { DEFAULT_WEEKLY } from "@scheduler/core";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { orgSettings, schedules, users, type Role } from "../db/schema";
import { RESERVED_USERNAMES, slugify } from "../lib/slug";

export type UserRow = typeof users.$inferSelect;

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    username: u.username,
    role: u.role,
    timezone: u.timezone,
    welcomeMessage: u.welcomeMessage,
    hasPassword: Boolean(u.passwordHash),
    disabled: Boolean(u.disabledAt),
    createdAt: u.createdAt,
  };
}

export async function userCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return Number(row?.n ?? 0);
}

export async function uniqueUsername(db: Db, seed: string): Promise<string> {
  const base = slugify(seed) || "user";
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (RESERVED_USERNAMES.has(candidate)) continue;
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate));
    if (!taken) return candidate;
  }
  throw new Error("Could not find a free username");
}

export async function createUser(
  db: Db,
  input: { email: string; name: string; role?: Role; timezone?: string; passwordHash?: string | null; username?: string; oidcSubject?: string },
): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const username = input.username ?? (await uniqueUsername(db, email.split("@")[0]));
  const timezone = input.timezone ?? "UTC";
  const [user] = await db
    .insert(users)
    .values({
      email,
      name: input.name.trim() || email,
      username,
      role: input.role ?? "member",
      timezone,
      passwordHash: input.passwordHash ?? null,
      oidcSubject: input.oidcSubject ?? null,
    })
    .returning();
  await db.insert(schedules).values({
    userId: user.id,
    name: "Working hours",
    timezone,
    weekly: DEFAULT_WEEKLY,
    overrides: [],
    isDefault: true,
  });
  return user;
}

export async function getOrgSettings(db: Db) {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, 1));
  if (row) return row;
  const [created] = await db.insert(orgSettings).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(orgSettings).where(eq(orgSettings.id, 1)))[0];
}
