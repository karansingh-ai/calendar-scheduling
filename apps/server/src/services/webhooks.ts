import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { bookingHosts, bookings, eventTypes, users, webhookDeliveries, webhooks, type WebhookEvent } from "../db/schema";
import { hmacSha256Hex } from "../lib/crypto";
import { badRequest } from "../lib/http";
import { assertAllowedUrl, BlockedUrlError, guardedFetch } from "../lib/outbound";
import { enqueue } from "./jobs";
import { serializeBooking } from "./serialize";

export const WEBHOOK_EVENTS: WebhookEvent[] = ["booking.created", "booking.rescheduled", "booking.cancelled"];

/**
 * URL checks at save time. Blocks cloud metadata and link-local targets (also re-checked on every delivery);
 * private network targets are allowed for internal tools.
 */
export async function validateWebhookUrl(ctx: AppContext, raw: string): Promise<string> {
  try {
    return (await assertAllowedUrl(raw, ctx.resolveHost)).toString();
  } catch (err) {
    if (err instanceof BlockedUrlError) throw badRequest(`Webhook URL rejected: ${err.message}`);
    throw err;
  }
}

/** POST a signed payload to a webhook URL. Redirects are not followed. */
export function postWebhook(ctx: AppContext, url: string, headers: Record<string, string>, body: string) {
  return guardedFetch(ctx.fetch, ctx.resolveHost, url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }, { timeoutMs: 10_000 });
}

/**
 * Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" using the webhook secret>`.
 * Receivers should recompute the HMAC and reject timestamps older than a few minutes.
 */
export function signatureHeader(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export async function bookingPayload(ctx: AppContext, bookingId: string) {
  const [row] = await ctx.db
    .select({ booking: bookings, eventType: eventTypes })
    .from(bookings)
    .innerJoin(eventTypes, eq(bookings.eventTypeId, eventTypes.id))
    .where(eq(bookings.id, bookingId));
  if (!row) return null;
  const hosts = await ctx.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(bookingHosts)
    .innerJoin(users, eq(bookingHosts.userId, users.id))
    .where(eq(bookingHosts.bookingId, bookingId));
  return { row, serialized: serializeBooking(row.booking, { eventType: row.eventType, hosts }), hosts };
}

export async function emitBookingEvent(ctx: AppContext, event: WebhookEvent, bookingId: string, extra: Record<string, unknown> = {}) {
  const data = await bookingPayload(ctx, bookingId);
  if (!data) return;
  const hostIds = data.hosts.map((h) => h.id);
  const targets = await ctx.db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.active, true),
        sql`${webhooks.events} @> ${JSON.stringify([event])}::jsonb`,
        or(eq(webhooks.scope, "org"), hostIds.length ? inArray(webhooks.userId, hostIds) : sql`false`),
      ),
    );
  for (const hook of targets) {
    const id = randomUUID();
    const payload = { id, event, createdAt: new Date().toISOString(), data: { booking: data.serialized, ...extra } };
    await ctx.db.insert(webhookDeliveries).values({ id, webhookId: hook.id, event, payload });
    await enqueue(ctx.db, "webhook.deliver", { deliveryId: id }, { maxAttempts: 8 });
  }
}

/** Deliver one webhook attempt. Throws on failure so the job queue retries with backoff. */
export async function deliverWebhook(ctx: AppContext, deliveryId: string) {
  const [row] = await ctx.db
    .select({ delivery: webhookDeliveries, hook: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row || row.delivery.status === "succeeded") return;
  if (!row.hook.active) {
    await ctx.db.update(webhookDeliveries).set({ status: "failed", lastError: "Webhook disabled" }).where(eq(webhookDeliveries.id, deliveryId));
    return;
  }
  const body = JSON.stringify(row.delivery.payload);
  const secret = ctx.encrypter.decrypt(row.hook.secretEnc);
  const attempts = row.delivery.attempts + 1;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await postWebhook(
      ctx,
      row.hook.url,
      {
        "user-agent": `${ctx.config.APP_NAME}-Webhooks/1.0`,
        "x-webhook-id": row.delivery.id,
        "x-webhook-event": row.delivery.event,
        "x-webhook-signature": signatureHeader(secret, body),
      },
      body,
    );
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await ctx.db
    .update(webhookDeliveries)
    .set({
      attempts,
      responseStatus: status,
      lastError: error,
      status: error ? (attempts >= 8 ? "failed" : "pending") : "succeeded",
      deliveredAt: error ? null : new Date(),
    })
    .where(eq(webhookDeliveries.id, deliveryId));
  if (error) throw new Error(`Webhook delivery failed: ${error}`);
}
