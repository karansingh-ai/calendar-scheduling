import { DateTime } from "luxon";
import {
  availableIntervals,
  containedIn,
  DAY,
  localDateKey,
  localWeekKey,
  mergeIntervals,
  MINUTE,
  overlapsAny,
} from "./time";
import type {
  BlockReason,
  BookingWindow,
  CandidateExplanation,
  HostInput,
  Interval,
  Slot,
  SlotQuery,
  SlotResult,
} from "./types";

interface PreparedHost {
  input: HostInput;
  zone: string;
  windows: Interval[];
  busy: Interval[];
  rawBusy: Interval[];
  eventStarts: Map<number, number>; // start -> bookings at that start
  dayCounts: Map<string, Set<number>>;
  weekCounts: Map<string, Set<number>>;
}

function prepareHost(host: HostInput, from: number, to: number): PreparedHost {
  const zone = host.schedule.timezone;
  const eventStarts = new Map<number, number>();
  const dayCounts = new Map<string, Set<number>>();
  const weekCounts = new Map<string, Set<number>>();
  for (const b of host.eventBookings ?? []) {
    eventStarts.set(b.start, (eventStarts.get(b.start) ?? 0) + 1);
    const d = localDateKey(b.start, zone);
    const w = localWeekKey(b.start, zone);
    if (!dayCounts.has(d)) dayCounts.set(d, new Set());
    if (!weekCounts.has(w)) weekCounts.set(w, new Set());
    dayCounts.get(d)!.add(b.start);
    weekCounts.get(w)!.add(b.start);
  }
  return {
    input: host,
    zone,
    windows: availableIntervals(host.schedule, from, to),
    busy: mergeIntervals(host.busy),
    rawBusy: host.busy,
    eventStarts,
    dayCounts,
    weekCounts,
  };
}

function bookingWindowAllows(window: BookingWindow | null | undefined, start: number, now: number, zone: string): boolean {
  if (!window) return true;
  if (window.type === "rolling") {
    const limit = DateTime.fromMillis(now, { zone }).startOf("day").plus({ days: window.days + 1 }).toMillis();
    return start < limit;
  }
  const date = localDateKey(start, zone);
  return date >= window.start && date <= window.end;
}

/**
 * Compute bookable slots for an event type.
 *
 * Candidate start times are generated from each host's working-hour windows, aligned to the
 * start of each window and spaced by the slot interval. Every candidate is then checked against
 * notice, booking window, working hours, busy time, buffers, limits and seats. The result is
 * combined per event kind:
 *  - one_on_one / group: the single host must be free (group: and have seats left)
 *  - collective: every host must be free
 *  - round_robin: at least one host must be free (optionally filtered by fairness)
 */
export function computeSlots(q: SlotQuery): SlotResult {
  if (q.durationMinutes <= 0) throw new Error("durationMinutes must be positive");
  if (q.hosts.length === 0) return { slots: [], explanations: q.explain ? [] : undefined };

  const dur = q.durationMinutes * MINUTE;
  const step = Math.max(5, q.slotIntervalMinutes || q.durationMinutes) * MINUTE;
  const before = (q.bufferBeforeMinutes ?? 0) * MINUTE;
  const after = (q.bufferAfterMinutes ?? 0) * MINUTE;
  const notice = (q.minimumNoticeMinutes ?? 0) * MINUTE;
  const seats = q.kind === "group" ? Math.max(1, q.seats ?? 1) : 1;

  const hosts = (q.kind === "one_on_one" || q.kind === "group" ? q.hosts.slice(0, 1) : q.hosts).map((h) =>
    prepareHost(h, q.rangeStart - DAY, q.rangeEnd + DAY + dur),
  );
  const windowZone = hosts[0].zone;

  // Candidate starts from every host's windows.
  const candidates = new Set<number>();
  for (const h of hosts) {
    for (const w of h.windows) {
      for (let t = w.start; t + dur <= w.end; t += step) {
        if (t >= q.rangeStart && t < q.rangeEnd) candidates.add(t);
      }
    }
    // Group events keep already-booked slots visible even if hours changed since.
    if (q.kind === "group") {
      for (const s of h.eventStarts.keys()) if (s >= q.rangeStart && s < q.rangeEnd) candidates.add(s);
    }
  }
  const starts = [...candidates].sort((a, b) => a - b);

  // Fairness baseline for round robin.
  const loads = new Map<string, number>();
  if (q.kind === "round_robin") {
    for (const h of hosts) {
      const weight = Math.max(0.0001, h.input.weight ?? 1);
      loads.set(h.input.hostId, (h.input.fairnessCount ?? 0) / weight);
    }
  }
  const minLoad = loads.size ? Math.min(...loads.values()) : 0;

  const slots: Slot[] = [];
  const explanations: CandidateExplanation[] = [];

  for (const start of starts) {
    const end = start + dur;
    const globalReasons: BlockReason[] = [];
    if (start < q.now) globalReasons.push("PAST");
    else if (start < q.now + notice) globalReasons.push("MINIMUM_NOTICE");
    if (!bookingWindowAllows(q.bookingWindow, start, q.now, windowZone)) globalReasons.push("OUTSIDE_BOOKING_WINDOW");

    let seatsTaken = 0;
    const hostResults = hosts.map((h) => {
      const reasons: BlockReason[] = [...globalReasons];
      const taken = h.eventStarts.get(start) ?? 0;
      if (q.kind === "group") seatsTaken = taken;
      const joiningExisting = q.kind === "group" && taken > 0;

      // A group slot that already has invitees stays bookable even if hours changed.
      if (!joiningExisting && !containedIn(h.windows, start, end)) reasons.push("OUTSIDE_WORKING_HOURS");

      // For a group slot with seats taken, the host's own copy of the meeting is not a conflict.
      let busy = joiningExisting
        ? mergeIntervals(h.rawBusy.filter((b) => !(b.start === start && b.end === end)))
        : h.busy;
      // A new group session must not overlap this event type's sessions at other start times (possible when
      // the slot interval is shorter than the duration). Joining an existing session is always allowed.
      if (q.kind === "group" && !joiningExisting) {
        const others = (h.input.eventBookings ?? []).filter((b) => b.start !== start);
        if (others.length) busy = mergeIntervals([...busy, ...others]);
      }
      if (overlapsAny(busy, start, end)) reasons.push("BUSY");
      else if ((before || after) && overlapsAny(busy, start - before, end + after)) reasons.push("BUFFER_CONFLICT");

      if (!joiningExisting) {
        if (q.dailyLimit && (h.dayCounts.get(localDateKey(start, h.zone))?.size ?? 0) >= q.dailyLimit) reasons.push("DAILY_LIMIT");
        if (q.weeklyLimit && (h.weekCounts.get(localWeekKey(start, h.zone))?.size ?? 0) >= q.weeklyLimit) reasons.push("WEEKLY_LIMIT");
      }
      if (q.kind === "group" && taken >= seats) reasons.push("FULL");

      if (q.kind === "round_robin" && q.maxImbalance && q.maxImbalance > 0 && hosts.length > 1) {
        const load = loads.get(h.input.hostId) ?? 0;
        if (load - minLoad >= q.maxImbalance) reasons.push("FAIRNESS");
      }
      return { hostId: h.input.hostId, available: reasons.length === 0, reasons };
    });

    let available: boolean;
    let hostIds: string[];
    if (q.kind === "collective") {
      available = hostResults.every((r) => r.available);
      hostIds = available ? hostResults.map((r) => r.hostId) : [];
    } else if (q.kind === "round_robin") {
      hostIds = hostResults.filter((r) => r.available).map((r) => r.hostId);
      available = hostIds.length > 0;
    } else {
      available = hostResults[0].available;
      hostIds = available ? [hostResults[0].hostId] : [];
    }

    if (available) {
      const slot: Slot = { start, end, hostIds };
      if (q.kind === "group") slot.seatsRemaining = seats - seatsTaken;
      slots.push(slot);
    }
    if (q.explain) explanations.push({ start, end, available, hosts: hostResults });
  }

  return { slots, explanations: q.explain ? explanations : undefined };
}

/**
 * Re-check a single requested start time. Used at booking time, inside the database transaction,
 * so that two invitees racing for the same slot cannot both succeed.
 */
export function isSlotAvailable(q: Omit<SlotQuery, "rangeStart" | "rangeEnd" | "explain">, start: number): Slot | null {
  const result = computeSlots({ ...q, rangeStart: start, rangeEnd: start + 1 });
  return result.slots.find((s) => s.start === start) ?? null;
}
