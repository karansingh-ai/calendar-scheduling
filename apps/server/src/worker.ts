import type { AppContext } from "./context";
import { claimDueJobs, completeJob, failJob, type JobRow } from "./services/jobs";
import { sendBookingEmails, type BookingEmailKind } from "./services/notifications";
import { deliverWebhook } from "./services/webhooks";

type Handler = (ctx: AppContext, payload: Record<string, unknown>) => Promise<void>;

const handlers: Record<string, Handler> = {
  "email.booking": (ctx, p) => sendBookingEmails(ctx, String(p.bookingId), p.kind as BookingEmailKind),
  "email.reminder": (ctx, p) => sendBookingEmails(ctx, String(p.bookingId), "reminder", Number(p.minutes)),
  "webhook.deliver": (ctx, p) => deliverWebhook(ctx, String(p.deliveryId)),
};

async function runJob(ctx: AppContext, job: JobRow) {
  const handler = handlers[job.type];
  if (!handler) {
    await failJob(ctx.db, { ...job, attempts: job.maxAttempts }, new Error(`No handler for job type ${job.type}`));
    return;
  }
  try {
    await handler(ctx, job.payload as Record<string, unknown>);
    await completeJob(ctx.db, job.id);
  } catch (err) {
    console.warn(`[jobs] ${job.type} #${job.id} attempt ${job.attempts} failed:`, err instanceof Error ? err.message : err);
    await failJob(ctx.db, job, err);
  }
}

/** Process every job that is due right now. Returns how many ran. */
export async function runDueJobs(ctx: AppContext): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = await claimDueJobs(ctx.db, 20);
    if (batch.length === 0) return total;
    for (const job of batch) await runJob(ctx, job);
    total += batch.length;
  }
}

export function startWorker(ctx: AppContext, intervalMs = 2000) {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const tick = async () => {
    if (stopped) return;
    running = runDueJobs(ctx).catch((err) => console.error("[jobs] worker error", err));
    await running;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 500);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
