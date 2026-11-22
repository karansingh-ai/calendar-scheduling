# API, webhooks and embedding

The full OpenAPI 3.1 spec is served at `/api/openapi.yaml` (source: `apps/server/openapi.yaml`).

## Authentication

Create a key under **Settings > API keys** and send it as a bearer token:

```bash
curl -H "Authorization: Bearer $SCHEDULER_KEY" https://schedule.acme.com/api/v1/me
```

Keys act as the user who created them and can be revoked at any time. Keys cannot create other keys.

## Common calls

List upcoming bookings:

```bash
curl -H "Authorization: Bearer $SCHEDULER_KEY" \
  "https://schedule.acme.com/api/v1/bookings?status=upcoming&limit=50"
```

Find open times and book one (public endpoints, no key needed):

```bash
ET=<event-type-id>
curl "https://schedule.acme.com/api/public/event-types/$ET/slots?start=2026-12-01T00:00:00Z&end=2026-12-08T00:00:00Z"

curl -X POST "https://schedule.acme.com/api/public/event-types/$ET/bookings" \
  -H "content-type: application/json" \
  -d '{"start":"2026-12-02T15:00:00Z","invitee":{"name":"Jane Doe","email":"jane@example.com","timezone":"America/New_York"},"answers":{"company":"Globex"}}'
```

Ask why times are unavailable (authenticated; useful when someone says "your calendar looks empty but I can't book"):

```bash
curl -H "Authorization: Bearer $SCHEDULER_KEY" \
  "https://schedule.acme.com/api/v1/event-types/$ET/slots?start=2026-12-02T00:00:00Z&end=2026-12-03T00:00:00Z&debug=true"
```

Each candidate time lists every host with reasons such as `OUTSIDE_WORKING_HOURS`, `BUSY`, `BUFFER_CONFLICT`, `MINIMUM_NOTICE`, `DAILY_LIMIT`, `WEEKLY_LIMIT`, `FULL` or `FAIRNESS`.

## Webhooks

Create webhooks under **Settings > Webhooks** or via `POST /api/v1/webhooks`. Events:

| Event | When |
|---|---|
| `booking.created` | A booking is made (public page, embed, API, or on behalf) |
| `booking.rescheduled` | A booking moves; `data.previousBookingId` holds the old booking |
| `booking.cancelled` | A booking is cancelled by the invitee, a host or an admin |

Payload:

```json
{
  "id": "6b0c...",
  "event": "booking.created",
  "createdAt": "2026-12-01T18:22:04.120Z",
  "data": { "booking": { "id": "...", "start": "...", "end": "...", "invitee": { "name": "...", "email": "..." }, "hosts": [...], "answers": {...} } }
}
```

Every request carries `x-webhook-signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of `"<t>.<raw request body>"` keyed with the webhook's signing secret. Verify it before trusting the payload:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < toleranceSeconds;
  return fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Respond with any 2xx status within 10 seconds. Other responses are retried with exponential backoff, up to 8 attempts. Delivery history is visible per webhook. Admins can create **organization-wide** webhooks that fire for every booking.

## Embedding on a website

Inline:

```html
<div data-scheduler-url="https://schedule.acme.com/jane/intro-call" style="min-width:320px;height:700px"></div>
<script src="https://schedule.acme.com/embed.js" async></script>
```

Popup button:

```html
<button data-scheduler-popup="https://schedule.acme.com/team/sales/demo">Book a demo</button>
<script src="https://schedule.acme.com/embed.js" async></script>
```

JavaScript API: `Scheduler.inline({ url, parent, prefill })`, `Scheduler.popup({ url })`, `Scheduler.close()`.

The embed dispatches browser events you can forward to analytics:

```js
window.addEventListener("scheduler:event_scheduled", (e) => {
  analytics.track("Meeting booked", { bookingId: e.detail.booking.id });
});
```

Other events: `scheduler:event_rescheduled`, `scheduler:event_canceled`, `scheduler:page_height` (add `data-scheduler-auto-height` to the container to resize automatically).
