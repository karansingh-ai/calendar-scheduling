import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { jobs } from "../db/schema";

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(db: Db, type: string, payload: unknown, opts: EnqueueOptions = {}) {
  await db
    .insert(jobs)
    .values({
      type,
      payload: payload as object,
      runAt: opts.runAt ?? new Date(),
      dedupeKey: opts.dedupeKey,
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .onConflictDoNothing();
}

export type JobRow = typeof jobs.$inferSelect;

/** Atomically claim due jobs. Safe with several worker processes (SKIP LOCKED). */
export async function claimDueJobs(db: Db, limit = 10): Promise<JobRow[]> {
  // Release jobs stuck in "running" (e.g. the process crashed mid-job).
  await db
    .update(jobs)
    .set({ status: "pending", lockedAt: null })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - 10 * 60_000))));

  const rows = await db.execute(sql`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id in (
      select id from jobs
      where status = 'pending' and run_at <= now()
      order by run_at
      limit ${limit}
      for update skip locked
    )
    returning id`);
  const ids = ((rows as unknown as { rows?: { id: number }[] }).rows ?? (rows as unknown as { id: number }[])).map((r) =>
    Number(r.id),
  );
  if (ids.length === 0) return [];
  return db.select().from(jobs).where(sql`${jobs.id} in ${ids}`);
}

export async function completeJob(db: Db, id: number) {
  await db.update(jobs).set({ status: "done", lockedAt: null }).where(eq(jobs.id, id));
}

export async function failJob(db: Db, job: JobRow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts >= job.maxAttempts) {
    await db.update(jobs).set({ status: "failed", lastError: message, lockedAt: null }).where(eq(jobs.id, job.id));
    return;
  }
  const backoffMs = Math.min(6 * 60 * 60_000, 30_000 * 2 ** (job.attempts - 1));
  await db
    .update(jobs)
    .set({ status: "pending", lastError: message, lockedAt: null, runAt: new Date(Date.now() + backoffMs) })
    .where(eq(jobs.id, job.id));
}
