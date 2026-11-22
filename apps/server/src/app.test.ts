import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "./lib/crypto";
import { ALWAYS_OPEN, dayStart, makeTestApp, type TestClient } from "./test/helpers";

type T = Awaited<ReturnType<typeof makeTestApp>>;

let t: T;
let owner: TestClient;

async function openSchedule(client: TestClient) {
  const { body } = await client.get("/api/v1/schedules");
  const id = body.schedules[0].id;
  const res = await client.patch(`/api/v1/schedules/${id}`, { timezone: "UTC", weekly: ALWAYS_OPEN });
  expect(res.status).toBe(200);
  return id;
}

async function slotsFor(eventTypeId: string, days = 2, from = 1) {
  const res = await t.client().get(
    `/api/public/event-types/${eventTypeId}/slots?start=${dayStart(from).toISOString()}&end=${dayStart(from + days).toISOString()}`,
  );
  expect(res.status).toBe(200);
  return res.body.slots as { start: string; end: string; seatsRemaining?: number }[];
}

async function book(eventTypeId: string, start: string, email = "jane@example.com", answers?: Record<string, string>) {
  return t.client().post(`/api/public/event-types/${eventTypeId}/bookings`, {
    start,
    invitee: { name: "Jane Invitee", email, timezone: "Europe/Paris" },
    answers,
  });
}

async function inviteMember(email: string, name: string) {
  const res = await owner.post("/api/v1/admin/users", { email, name });
  expect(res.status).toBe(201);
  const token = res.body.inviteUrl.split("/invite/")[1];
  const client = t.client();
  const accept = await client.post(`/api/auth/invite/${token}`, { password: "correct horse battery", timezone: "UTC" });
  expect(accept.status).toBe(200);
  await openSchedule(client);
  return { client, id: res.body.user.id as string };
}

beforeAll(async () => {
  t = await makeTestApp();
  owner = t.client();
});
afterAll(async () => {
  await t.close();
});

describe("setup and authentication", () => {
  it("requires setup on a fresh install", async () => {
    const res = await t.client().get("/api/auth/status");
    expect(res.body.setupRequired).toBe(true);
    expect(res.body.user).toBeNull();
  });

  it("creates the owner account and signs in", async () => {
    const res = await owner.post("/api/auth/setup", {
      name: "Olivia Owner",
      email: "Owner@Acme.test",
      password: "correct horse battery",
      timezone: "UTC",
      orgName: "Acme",
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("owner");
    expect(res.body.user.email).toBe("owner@acme.test");
    const status = await owner.get("/api/auth/status");
    expect(status.body.setupRequired).toBe(false);
    expect(status.body.orgName).toBe("Acme");
    expect(status.body.user.username).toBe("owner");
  });

  it("refuses a second setup", async () => {
    const res = await t.client().post("/api/auth/setup", { name: "X", email: "x@x.test", password: "correct horse battery", timezone: "UTC", orgName: "X" });
    expect(res.status).toBe(409);
  });

  it("rejects bad passwords and accepts good ones", async () => {
    const c = t.client();
    expect((await c.post("/api/auth/login", { email: "owner@acme.test", password: "nope nope nope" })).status).toBe(401);
    expect((await c.post("/api/auth/login", { email: "owner@acme.test", password: "correct horse battery" })).status).toBe(200);
    expect((await c.get("/api/v1/me")).body.user.email).toBe("owner@acme.test");
    await c.post("/api/auth/logout");
    expect((await c.get("/api/v1/me")).status).toBe(401);
  });

  it("blocks cross-origin writes (CSRF)", async () => {
    const res = await owner.req("POST", "/api/v1/event-types", { title: "Evil" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("rejects non-JSON writes", async () => {
    const res = await owner.req("POST", "/api/auth/logout", undefined, { "content-type": "text/plain", "content-length": "3" });
    expect(res.status).toBe(415);
  });
});

describe("one-on-one booking lifecycle", () => {
  let eventTypeId: string;

  it("creates an event type with custom questions", async () => {
    await openSchedule(owner);
    const res = await owner.post("/api/v1/event-types", {
      title: "Intro Call",
      durationMinutes: 30,
      minimumNoticeMinutes: 0,
      location: { type: "link", value: "https://meet.example.com/olivia" },
      questions: [{ id: "company", label: "Company", type: "text", required: true }],
    });
    expect(res.status).toBe(201);
    expect(res.body.eventType.slug).toBe("intro-call");
    eventTypeId = res.body.eventType.id;
  });

  it("rejects a duplicate slug", async () => {
    const res = await owner.post("/api/v1/event-types", { title: "Intro Call" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("slug_taken");
  });

  it("serves the public page and slots", async () => {
    const page = await t.client().get("/api/public/users/owner/event-types/intro-call");
    expect(page.status).toBe(200);
    expect(page.body.eventType.location.value).toBeUndefined(); // link hidden until booked
    const slots = await slotsFor(eventTypeId);
    expect(slots.length).toBe(96); // 2 days x 48 half-hours
  });

  it("validates required answers", async () => {
    const [slot] = await slotsFor(eventTypeId);
    const res = await book(eventTypeId, slot.start);
    expect(res.status).toBe(400);
  });

  let manage: { id: string; token: string };
  it("books a slot, then blocks double booking", async () => {
    const [slot] = await slotsFor(eventTypeId);
    const res = await book(eventTypeId, slot.start, "jane@example.com", { company: "Globex" });
    expect(res.status).toBe(201);
    expect(res.body.booking.location.joinUrl).toBe("https://meet.example.com/olivia");
    manage = { id: res.body.booking.id, token: res.body.manageToken };
    const again = await book(eventTypeId, slot.start, "bob@example.com", { company: "Initech" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("slot_unavailable");
    const remaining = await slotsFor(eventTypeId);
    expect(remaining.find((s) => s.start === slot.start)).toBeUndefined();
  });

  it("rejects start times that are not offered", async () => {
    const odd = new Date(dayStart(1).getTime() + 7 * 60_000).toISOString();
    expect((await book(eventTypeId, odd, "x@example.com", { company: "X" })).status).toBe(409);
  });

  it("sends confirmation emails with an invite attached", async () => {
    t.mailer.messages = [];
    await t.runJobs();
    const toInvitee = t.mailer.messages.find((m) => m.to === "jane@example.com")!;
    const toHost = t.mailer.messages.find((m) => m.to === "owner@acme.test")!;
    expect(toInvitee.subject).toMatch(/^Confirmed: Intro Call/);
    expect(toInvitee.ics?.content).toContain("BEGIN:VEVENT");
    expect(toInvitee.text).toContain(`/booking/${manage.id}?token=`);
    expect(toHost.text).toContain("Company: Globex");
  });

  it("lets the invitee view and reschedule with the manage token", async () => {
    const c = t.client();
    expect((await c.get(`/api/public/bookings/${manage.id}?token=wrong`)).status).toBe(404);
    const view = await c.get(`/api/public/bookings/${manage.id}?token=${manage.token}`);
    expect(view.status).toBe(200);
    expect(view.body.canReschedule).toBe(true);
    const slots = await slotsFor(eventTypeId);
    const res = await c.post(`/api/public/bookings/${manage.id}/reschedule`, { token: manage.token, start: slots[5].start });
    expect(res.status).toBe(201);
    expect(res.body.booking.rescheduledFromId).toBe(manage.id);
    const old = await c.get(`/api/public/bookings/${manage.id}?token=${manage.token}`);
    expect(old.body.booking.status).toBe("cancelled");
    manage = { id: res.body.booking.id, token: res.body.manageToken };
  });

  it("lets the invitee cancel", async () => {
    const res = await t.client().post(`/api/public/bookings/${manage.id}/cancel`, { token: manage.token, reason: "Conflict" });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("cancelled");
    expect(res.body.booking.cancelledBy).toBe("invitee");
  });

  it("lists bookings for the host", async () => {
    const res = await owner.get("/api/v1/bookings?status=cancelled");
    expect(res.status).toBe(200);
    expect(res.body.bookings.length).toBe(2);
  });

  it("explains why slots are blocked", async () => {
    const res = await owner.get(
      `/api/v1/event-types/${eventTypeId}/slots?start=${dayStart(-1).toISOString()}&end=${dayStart(0).toISOString()}&debug=true`,
    );
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(0);
    expect(res.body.explanations[0].hosts[0].reasons).toContain("PAST");
  });
});

describe("team scheduling", () => {
  let alice: { client: TestClient; id: string };
  let bob: { client: TestClient; id: string };
  let teamId: string;

  it("invites members and builds a team", async () => {
    alice = await inviteMember("alice@acme.test", "Alice");
    bob = await inviteMember("bob@acme.test", "Bob");
    const team = await owner.post("/api/v1/teams", { name: "Sales" });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    const members = await owner.put(`/api/v1/teams/${teamId}/members`, {
      members: [
        { userId: alice.id, role: "manager" },
        { userId: bob.id, role: "member" },
      ],
    });
    expect(members.body.team.members).toHaveLength(2);
  });

  it("members cannot reach admin endpoints", async () => {
    expect((await bob.client.get("/api/v1/admin/users")).status).toBe(403);
  });

  it("round robin spreads simultaneous bookings across hosts", async () => {
    const res = await alice.client.post("/api/v1/event-types", {
      title: "Demo",
      kind: "round_robin",
      teamId,
      minimumNoticeMinutes: 0,
      hosts: [
        { userId: alice.id, priority: 2 },
        { userId: bob.id, priority: 1 },
      ],
    });
    expect(res.status).toBe(201);
    const id = res.body.eventType.id;
    const page = await t.client().get("/api/public/teams/sales/event-types/demo");
    expect(page.status).toBe(200);
    const [slot] = await slotsFor(id);
    const first = await book(id, slot.start, "a@example.com");
    const second = await book(id, slot.start, "b@example.com");
    const third = await book(id, slot.start, "c@example.com");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(409);
    expect(first.body.booking.hostUserId).toBe(alice.id); // higher priority
    expect(second.body.booking.hostUserId).toBe(bob.id);
    const detail = await owner.get(`/api/v1/bookings/${first.body.booking.id}`);
    expect(detail.body.booking.assignmentReason).toMatch(/priority|only available/);
  });

  it("collective needs every host free", async () => {
    const res = await alice.client.post("/api/v1/event-types", {
      title: "Panel",
      kind: "collective",
      teamId,
      minimumNoticeMinutes: 0,
      durationMinutes: 60,
      hosts: [{ userId: alice.id }, { userId: bob.id }],
    });
    expect(res.status).toBe(201);
    const id = res.body.eventType.id;
    const before = await slotsFor(id, 1, 2);
    const booked = await book(id, before[0].start, "panel@example.com");
    expect(booked.status).toBe(201);
    expect(booked.body.booking.hosts.map((h: { id: string }) => h.id).sort()).toEqual([alice.id, bob.id].sort());
    const after = await slotsFor(id, 1, 2);
    expect(after.find((s) => s.start === before[0].start)).toBeUndefined();
  });

  it("a host's booking blocks their other event types", async () => {
    const res = await bob.client.post("/api/v1/event-types", { title: "Bob 1:1", minimumNoticeMinutes: 0, durationMinutes: 60 });
    const panelDay = await slotsFor(res.body.eventType.id, 1, 2);
    // Bob is busy for the first collective hour on day 2.
    expect(panelDay.find((s) => s.start === dayStart(2).toISOString())).toBeUndefined();
  });

  it("group events fill seats", async () => {
    const res = await owner.post("/api/v1/event-types", { title: "Workshop", kind: "group", seats: 2, minimumNoticeMinutes: 0, durationMinutes: 60 });
    expect(res.status).toBe(201);
    const id = res.body.eventType.id;
    const [slot] = await slotsFor(id, 1, 3);
    expect(slot.seatsRemaining).toBe(2);
    expect((await book(id, slot.start, "g1@example.com")).status).toBe(201);
    const mid = await slotsFor(id, 1, 3);
    expect(mid.find((s) => s.start === slot.start)?.seatsRemaining).toBe(1);
    expect((await book(id, slot.start, "g2@example.com")).status).toBe(201);
    expect((await book(id, slot.start, "g3@example.com")).status).toBe(409);
  });

  it("rejects invalid kind configurations", async () => {
    expect((await owner.post("/api/v1/event-types", { title: "Bad group", kind: "group" })).status).toBe(400);
    expect((await owner.post("/api/v1/event-types", { title: "Bad collective", kind: "collective" })).status).toBe(400);
  });

  it("members cannot edit someone else's event types", async () => {
    const list = await owner.get("/api/v1/event-types");
    const ownerEvent = list.body.eventTypes.find((e: { slug: string }) => e.slug === "intro-call");
    expect((await bob.client.patch(`/api/v1/event-types/${ownerEvent.id}`, { title: "Hacked" })).status).toBe(404);
  });
});

describe("integrations", () => {
  it("API keys authenticate and can be revoked", async () => {
    const created = await owner.post("/api/v1/api-keys", { name: "CI" });
    expect(created.status).toBe(201);
    const api = t.client();
    api.bearer = created.body.secret;
    expect((await api.get("/api/v1/me")).body.user.email).toBe("owner@acme.test");
    // API keys cannot mint more API keys.
    expect((await api.post("/api/v1/api-keys", { name: "nested" })).status).toBe(403);
    await owner.del(`/api/v1/api-keys/${created.body.apiKey.id}`);
    expect((await api.get("/api/v1/me")).status).toBe(401);
  });

  it("delivers signed webhooks", async () => {
    const hook = await owner.post("/api/v1/webhooks", { url: "https://hooks.example.com/in", events: ["booking.created"] });
    expect(hook.status).toBe(201);
    const secret = hook.body.secret as string;
    expect((await owner.post("/api/v1/webhooks", { url: "http://169.254.169.254/latest", events: ["booking.created"] })).status).toBe(400);

    const list = await owner.get("/api/v1/event-types");
    const et = list.body.eventTypes.find((e: { slug: string }) => e.slug === "intro-call");
    const slots = await slotsFor(et.id, 1, 4);
    t.calls.length = 0;
    const booked = await book(et.id, slots[0].start, "hook@example.com", { company: "Hooli" });
    expect(booked.status).toBe(201);
    await t.runJobs();
    const call = t.calls.find((c) => c.url === "https://hooks.example.com/in")!;
    expect(call).toBeDefined();
    const headers = call.init!.headers as Record<string, string>;
    const [tPart, vPart] = headers["x-webhook-signature"].split(",");
    const ts = tPart.slice(2);
    expect(vPart.slice(3)).toBe(hmacSha256Hex(secret, `${ts}.${call.init!.body}`));
    const payload = JSON.parse(String(call.init!.body));
    expect(payload.event).toBe("booking.created");
    expect(payload.data.booking.invitee.email).toBe("hook@example.com");
    const deliveries = await owner.get(`/api/v1/webhooks/${hook.body.webhook.id}/deliveries`);
    expect(deliveries.body.deliveries[0].status).toBe("succeeded");
  });

  it("reads busy time from an ICS feed", async () => {
    const busyStart = new Date(dayStart(5).getTime() + 10 * 3600_000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:busy-1",
      `DTSTART:${fmt(busyStart)}`,
      `DTEND:${fmt(new Date(busyStart.getTime() + 3600_000))}`,
      "SUMMARY:Dentist",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    t.respond((u) => u.startsWith("https://cal.example.com/"), () => new Response(ics, { status: 200, headers: { "content-type": "text/calendar" } }));
    const res = await owner.post("/api/v1/calendar-connections/ics", { url: "webcal://cal.example.com/feed.ics", name: "Personal" });
    expect(res.status).toBe(201);
    const list = await owner.get("/api/v1/event-types");
    const et = list.body.eventTypes.find((e: { slug: string }) => e.slug === "intro-call");
    const slots = await slotsFor(et.id, 1, 5);
    expect(slots.find((s) => s.start === busyStart.toISOString())).toBeUndefined();
    expect(slots.find((s) => s.start === new Date(busyStart.getTime() - 30 * 60_000).toISOString())).toBeDefined();
    const cals = await owner.get("/api/v1/calendars");
    expect(cals.body.connections[0].provider).toBe("ics");
  });

  it("records an audit trail", async () => {
    const res = await owner.get("/api/v1/admin/audit?limit=500");
    const actions = new Set(res.body.entries.map((e: { action: string }) => e.action));
    for (const a of ["org.setup", "user.invited", "event_type.created", "booking.created", "booking.rescheduled", "booking.cancelled", "api_key.created", "webhook.created", "auth.login_failed"]) {
      expect(actions.has(a)).toBe(true);
    }
    const csv = await owner.get("/api/v1/admin/audit.csv");
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain("booking.created");
  });
});
