import type { Assignment, AssignmentCandidate, RoundRobinStrategy } from "./types";

/** Small deterministic hash so ties break the same way for the same slot (testable, no Math.random). */
function tieBreak(seed: string, hostId: string): number {
  let h = 2166136261;
  const s = `${seed}:${hostId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function load(c: AssignmentCandidate): number {
  return (c.fairnessCount ?? 0) / Math.max(0.0001, c.weight ?? 1);
}

/**
 * Pick the host for a round-robin booking from the hosts who are free at that time.
 *
 * - maximize_availability: highest priority wins; ties go to the host booked least recently.
 * - equal_distribution: lowest weighted load (bookings / weight) wins; ties use priority, then recency.
 *
 * Returns the chosen host plus a human-readable reason that is stored on the booking.
 */
export function assignRoundRobin(
  candidates: AssignmentCandidate[],
  strategy: RoundRobinStrategy,
  seed: string,
): Assignment {
  if (candidates.length === 0) throw new Error("No available hosts to assign");
  if (candidates.length === 1) return { hostId: candidates[0].hostId, reason: "only available host" };

  const recency = (c: AssignmentCandidate) => c.lastBookedAt ?? -Infinity;
  const sorted = [...candidates].sort((a, b) => {
    if (strategy === "equal_distribution") {
      const d = load(a) - load(b);
      if (Math.abs(d) > 1e-9) return d;
    }
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;
    const r = recency(a) - recency(b);
    if (r !== 0) return r;
    return tieBreak(seed, a.hostId) - tieBreak(seed, b.hostId);
  });

  const winner = sorted[0];
  const runnerUp = sorted[1];
  const n = candidates.length;
  let reason: string;
  if (strategy === "equal_distribution" && Math.abs(load(winner) - load(runnerUp)) > 1e-9) {
    reason = `fewest weighted bookings (${load(winner).toFixed(2)}) among ${n} available hosts`;
  } else if ((winner.priority ?? 0) !== (runnerUp.priority ?? 0)) {
    reason = `highest priority (${winner.priority ?? 0}) among ${n} available hosts`;
  } else if (recency(winner) !== recency(runnerUp)) {
    reason = `least recently booked among ${n} available hosts at the same priority`;
  } else {
    reason = `tie among ${n} available hosts, broken deterministically`;
  }
  return { hostId: winner.hostId, reason };
}
