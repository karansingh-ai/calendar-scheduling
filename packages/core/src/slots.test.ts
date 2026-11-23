import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { assignRoundRobin, computeSlots, isSlotAvailable, validateSchedule } from "./index";
import type { HostInput, Schedule, SlotQuery } from "./types";

const NY = "America/New_York";
const weekdays9to5 = (timezone = NY): Schedule => ({
  timezone,
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day: day as 1, ranges: [{ start: "09:00", end: "17:00" }] })),
  overrides: [],
});

const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toMillis();
const dayRange = (date: string, zone = NY) => ({
  rangeStart: at(`${date}T00:00`, zone),
  rangeEnd: DateTime.fromISO(date, { zone }).plus({ days: 1 }).toMillis(),
});
const host = (overrides: Partial<HostInput> = {}): HostInput => ({
  hostId: "h1",
  schedule: weekdays9to5(),
  busy: [],
  ...overrides,
});
const base = (date: string, extra: Partial<SlotQuery> = {}): SlotQuery => ({
  kind: "one_on_one",
  ...dayRange(date),
  now: at("2026-01-01T00:00"),
  durationMinutes: 30,
  hosts: [host()],
  ...extra,
});
const localTimes = (starts: number[], zone = NY) =>
  starts.map((s) => DateTime.fromMillis(s, { zone }).toFormat("HH:mm"));

describe("computeSlots: one-on-one basics", () => {
  it("is Monday", () => {
    expect(DateTime.fromISO("2026-12-07").weekday).toBe(1);
  });

  it("generates 30-minute slots across 09:00-17:00", () => {
    const { slots } = computeSlots(base("2026-12-07"));
    expect(slots).toHaveLength(16);
    expect(localTimes(slots.map((s) => s.start))[0]).toBe("09:00");
    expect(localTimes(slots.map((s) => s.start)).at(-1)).toBe("16:30");
    expect(slots[0].hostIds).toEqual(["h1"]);
  });

  it("returns nothing on a weekend", () => {
    expect(computeSlots(base("2026-12-06")).slots).toHaveLength(0);
  });

  it("uses a custom slot interval", () => {
    const { slots } = computeSlots(base("2026-12-07", { durationMinutes: 60, slotIntervalMinutes: 30 }));
    // 09:00 ... 16:00 every 30 minutes = 15 slots
    expect(slots).toHaveLength(15);
  });

  it("removes slots that overlap busy time but keeps touching slots", () => {
    const busy = [{ start: at("2026-12-07T10:00"), end: at("2026-12-07T11:00") }];
    const { slots } = computeSlots(base("2026-12-07", { hosts: [host({ busy })] }));
    const times = localTimes(slots.map((s) => s.start));
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("10:30");
    expect(times).toContain("09:30");
    expect(times).toContain("11:00");
  });

  it("applies buffers before and after", () => {
    const busy = [{ start: at("2026-12-07T12:00"), end: at("2026-12-07T13:00") }];
    const { slots, explanations } = computeSlots(
      base("2026-12-07", { hosts: [host({ busy })], bufferBeforeMinutes: 15, bufferAfterMinutes: 15, explain: true }),
    );
    const times = localTimes(slots.map((s) => s.start));
    expect(times).not.toContain("11:30"); // ends 12:00, after-buffer hits busy
    expect(times).not.toContain("13:00"); // before-buffer hits busy
    expect(times).toContain("11:00");
    expect(times).toContain("13:30");
    const e = explanations!.find((x) => x.start === at("2026-12-07T11:30"))!;
    expect(e.hosts[0].reasons).toEqual(["BUFFER_CONFLICT"]);
  });

  it("enforces minimum notice and hides past slots", () => {
    const { slots, explanations } = computeSlots(
      base("2026-12-07", { now: at("2026-12-07T10:10"), minimumNoticeMinutes: 60, explain: true }),
    );
    expect(localTimes(slots.map((s) => s.start))[0]).toBe("11:30");
    const reasons = (t: string) => explanations!.find((x) => x.start === at(`2026-12-07T${t}`))!.hosts[0].reasons;
    expect(reasons("09:30")).toEqual(["PAST"]);
    expect(reasons("11:00")).toEqual(["MINIMUM_NOTICE"]);
  });

  it("supports ranges that end at 24:00", () => {
    const schedule: Schedule = { timezone: NY, weekly: [{ day: 1, ranges: [{ start: "22:00", end: "24:00" }] }], overrides: [] };
    const { slots } = computeSlots(base("2026-12-07", { hosts: [host({ schedule })], durationMinutes: 60 }));
    expect(localTimes(slots.map((s) => s.start))).toEqual(["22:00", "23:00"]);
  });

  it("handles split ranges in one day", () => {
    const schedule: Schedule = {
      timezone: NY,
      weekly: [{ day: 1, ranges: [{ start: "09:00", end: "10:00" }, { start: "14:00", end: "15:00" }] }],
      overrides: [],
    };
    const { slots } = computeSlots(base("2026-12-07", { hosts: [host({ schedule })] }));
    expect(localTimes(slots.map((s) => s.start))).toEqual(["09:00", "09:30", "14:00", "14:30"]);
  });
});

describe("computeSlots: overrides, windows and limits", () => {
  it("date override can block a day", () => {
    const schedule = { ...weekdays9to5(), overrides: [{ date: "2026-12-07", ranges: [] }] };
    expect(computeSlots(base("2026-12-07", { hosts: [host({ schedule })] })).slots).toHaveLength(0);
  });

  it("date override can open a weekend day with custom hours", () => {
    const schedule = { ...weekdays9to5(), overrides: [{ date: "2026-12-06", ranges: [{ start: "10:00", end: "11:00" }] }] };
    const { slots } = computeSlots(base("2026-12-06", { hosts: [host({ schedule })] }));
    expect(localTimes(slots.map((s) => s.start))).toEqual(["10:00", "10:30"]);
  });

  it("rolling booking window stops after N days", () => {
    const now = at("2026-12-07T08:00");
    const q = (date: string) => computeSlots(base(date, { now, bookingWindow: { type: "rolling", days: 2 } })).slots.length;
    expect(q("2026-12-09")).toBe(16); // today + 2
    expect(q("2026-12-10")).toBe(0);
  });

  it("date-range booking window", () => {
    const bookingWindow = { type: "range" as const, start: "2026-12-08", end: "2026-12-08" };
    expect(computeSlots(base("2026-12-07", { bookingWindow })).slots).toHaveLength(0);
    expect(computeSlots(base("2026-12-08", { bookingWindow })).slots).toHaveLength(16);
  });

  it("daily limit blocks the rest of the day once reached", () => {
    const eventBookings = [
      { start: at("2026-12-07T09:00"), end: at("2026-12-07T09:30") },
      { start: at("2026-12-07T10:00"), end: at("2026-12-07T10:30") },
    ];
    const busy = eventBookings;
    const { slots, explanations } = computeSlots(
      base("2026-12-07", { hosts: [host({ eventBookings, busy })], dailyLimit: 2, explain: true }),
    );
    expect(slots).toHaveLength(0);
    expect(explanations!.find((e) => e.start === at("2026-12-07T15:00"))!.hosts[0].reasons).toContain("DAILY_LIMIT");
    // Next day is unaffected.
    expect(computeSlots(base("2026-12-08", { hosts: [host({ eventBookings, busy })], dailyLimit: 2 })).slots).toHaveLength(16);
  });

  it("weekly limit counts the whole ISO week", () => {
    const eventBookings = [{ start: at("2026-12-07T09:00"), end: at("2026-12-07T09:30") }];
    expect(computeSlots(base("2026-12-09", { hosts: [host({ eventBookings })], weeklyLimit: 1 })).slots).toHaveLength(0);
    expect(computeSlots(base("2026-12-14", { hosts: [host({ eventBookings })], weeklyLimit: 1 })).slots).toHaveLength(16);
  });
});

describe("computeSlots: daylight saving time", () => {
  it("keeps 09:00 local across the March transition", () => {
    const before = computeSlots(base("2026-03-06")).slots[0].start; // Friday, EST (UTC-5)
    const after = computeSlots(base("2026-03-09")).slots[0].start; // Monday, EDT (UTC-4)
    expect(new Date(before).toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(new Date(after).toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("keeps 09:00 local across the November transition", () => {
    const after = computeSlots(base("2026-11-02")).slots[0].start; // Monday, EST
    expect(new Date(after).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("produces the right number of slots on the transition day itself", () => {
    const schedule: Schedule = { timezone: NY, weekly: [{ day: 7, ranges: [{ start: "00:00", end: "24:00" }] }], overrides: [] };
    const spring = computeSlots(base("2026-03-08", { hosts: [host({ schedule })], durationMinutes: 60 }));
    const fall = computeSlots(base("2026-11-01", { hosts: [host({ schedule })], durationMinutes: 60 }));
    expect(spring.slots).toHaveLength(23); // the 02:00 hour does not exist
    expect(fall.slots).toHaveLength(25); // the 01:00 hour happens twice
  });
});

describe("computeSlots: multi-host events", () => {
  const london: Schedule = weekdays9to5("Europe/London");

  it("collective shows only times when every host is free", () => {
    // NY 09:00-17:00 is 14:00-22:00 London; London 09:00-17:00 is 04:00-12:00 NY. Overlap: 09:00-12:00 NY.
    const { slots } = computeSlots(
      base("2026-12-07", { kind: "collective", hosts: [host(), host({ hostId: "h2", schedule: london })] }),
    );
    expect(localTimes(slots.map((s) => s.start))).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
    expect(slots[0].hostIds).toEqual(["h1", "h2"]);
  });

  it("collective is blocked when one host is busy", () => {
    const busy = [{ start: at("2026-12-07T10:00"), end: at("2026-12-07T11:00") }];
    const { slots } = computeSlots(
      base("2026-12-07", { kind: "collective", hosts: [host(), host({ hostId: "h2", schedule: london, busy })] }),
    );
    expect(localTimes(slots.map((s) => s.start))).toEqual(["09:00", "09:30", "11:00", "11:30"]);
  });

  it("round robin offers the union of host availability", () => {
    const { slots } = computeSlots(
      base("2026-12-07", { kind: "round_robin", hosts: [host(), host({ hostId: "h2", schedule: london })] }),
    );
    const first = slots[0];
    expect(localTimes([first.start])).toEqual(["04:00"]);
    expect(first.hostIds).toEqual(["h2"]);
    const shared = slots.find((s) => localTimes([s.start])[0] === "10:00")!;
    expect(shared.hostIds.sort()).toEqual(["h1", "h2"]);
  });

  it("round robin fairness hides hosts too far ahead", () => {
    const { slots } = computeSlots(
      base("2026-12-07", {
        kind: "round_robin",
        maxImbalance: 3,
        hosts: [host({ fairnessCount: 5 }), host({ hostId: "h2", fairnessCount: 1 })],
      }),
    );
    expect(slots.every((s) => s.hostIds.length === 1 && s.hostIds[0] === "h2")).toBe(true);
  });

  it("round robin fairness respects weights", () => {
    const { slots } = computeSlots(
      base("2026-12-07", {
        kind: "round_robin",
        maxImbalance: 3,
        hosts: [host({ fairnessCount: 5, weight: 2 }), host({ hostId: "h2", fairnessCount: 1 })],
      }),
    );
    // h1 weighted load 2.5 vs h2 1 => gap 1.5 < 3, both stay.
    expect(slots[0].hostIds.sort()).toEqual(["h1", "h2"]);
  });
});

describe("computeSlots: group events", () => {
  const slot = { start: at("2026-12-07T10:00"), end: at("2026-12-07T10:30") };

  it("counts seats and keeps the slot open until full", () => {
    const res = computeSlots(base("2026-12-07", { kind: "group", seats: 3, hosts: [host({ eventBookings: [slot, slot], busy: [slot] })] }));
    const s = res.slots.find((x) => x.start === slot.start)!;
    expect(s.seatsRemaining).toBe(1);
  });

  it("marks a slot full", () => {
    const res = computeSlots(
      base("2026-12-07", { kind: "group", seats: 2, explain: true, hosts: [host({ eventBookings: [slot, slot], busy: [slot] })] }),
    );
    expect(res.slots.find((x) => x.start === slot.start)).toBeUndefined();
    expect(res.explanations!.find((x) => x.start === slot.start)!.hosts[0].reasons).toContain("FULL");
  });

  it("does not start a new session that overlaps another session of the same event", () => {
    // 60-minute sessions every 30 minutes; the 10:00-11:00 session already has an invitee.
    const session = { start: at("2026-12-07T10:00"), end: at("2026-12-07T11:00") };
    const res = computeSlots(
      base("2026-12-07", { kind: "group", seats: 5, durationMinutes: 60, slotIntervalMinutes: 30, explain: true, hosts: [host({ eventBookings: [session] })] }),
    );
    const times = localTimes(res.slots.map((x) => x.start));
    expect(times).toContain("10:00"); // joining the existing session
    expect(times).not.toContain("09:30");
    expect(times).not.toContain("10:30");
    expect(times).toContain("11:00");
    expect(res.explanations!.find((x) => x.start === at("2026-12-07T10:30"))!.hosts[0].reasons).toContain("BUSY");
  });

  it("still blocks the group slot when the host has another meeting", () => {
    const other = { start: at("2026-12-07T10:15"), end: at("2026-12-07T10:45") };
    const res = computeSlots(base("2026-12-07", { kind: "group", seats: 5, hosts: [host({ eventBookings: [slot], busy: [slot, other] })] }));
    expect(res.slots.find((x) => x.start === slot.start)).toBeUndefined();
  });
});

describe("isSlotAvailable", () => {
  it("accepts an offered slot and rejects an unaligned one", () => {
    const q = base("2026-12-07");
    expect(isSlotAvailable(q, at("2026-12-07T09:30"))).not.toBeNull();
    expect(isSlotAvailable(q, at("2026-12-07T09:10"))).toBeNull();
  });
});

describe("assignRoundRobin", () => {
  it("maximize availability prefers priority, then least recent", () => {
    const a = assignRoundRobin(
      [
        { hostId: "a", priority: 1, lastBookedAt: 100 },
        { hostId: "b", priority: 2, lastBookedAt: 500 },
      ],
      "maximize_availability",
      "seed",
    );
    expect(a.hostId).toBe("b");
    expect(a.reason).toContain("highest priority");
    const b = assignRoundRobin(
      [
        { hostId: "a", priority: 1, lastBookedAt: 100 },
        { hostId: "b", priority: 1, lastBookedAt: 500 },
        { hostId: "c", priority: 1, lastBookedAt: null },
      ],
      "maximize_availability",
      "seed",
    );
    expect(b.hostId).toBe("c");
    expect(b.reason).toContain("least recently booked");
  });

  it("equal distribution prefers the lowest weighted load", () => {
    const a = assignRoundRobin(
      [
        { hostId: "a", fairnessCount: 4, weight: 2 },
        { hostId: "b", fairnessCount: 3, weight: 1 },
      ],
      "equal_distribution",
      "seed",
    );
    expect(a.hostId).toBe("a");
    expect(a.reason).toContain("fewest weighted bookings");
  });

  it("breaks exact ties deterministically", () => {
    const c = [{ hostId: "a" }, { hostId: "b" }];
    expect(assignRoundRobin(c, "maximize_availability", "x").hostId).toBe(assignRoundRobin(c, "maximize_availability", "x").hostId);
  });
});

describe("validateSchedule", () => {
  it("accepts a valid schedule", () => {
    expect(validateSchedule(weekdays9to5())).toEqual([]);
  });

  it("reports bad zones, overlaps and reversed ranges", () => {
    const errors = validateSchedule({
      timezone: "Mars/Olympus",
      weekly: [{ day: 1, ranges: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }],
      overrides: [{ date: "2026-12-07", ranges: [{ start: "15:00", end: "14:00" }] }],
    });
    expect(errors.join("|")).toMatch(/time zone/);
    expect(errors.join("|")).toMatch(/overlap/);
    expect(errors.join("|")).toMatch(/end after/);
  });
});
