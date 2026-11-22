import { DateTime } from "luxon";
import type { DateOverride, Interval, Schedule, TimeRange, Weekday } from "./types";

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;

export function isValidTime(value: string): boolean {
  const m = TIME_RE.exec(value);
  if (!m) return false;
  if (m[1] === "24" && m[2] !== "00") return false;
  return true;
}

export function isValidTimeZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

function minutesOf(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** Convert a local date + minutes-from-midnight in `zone` to a UTC instant (DST safe). */
export function localToInstant(date: string, minutes: number, zone: string): number {
  const day = DateTime.fromISO(date, { zone }).startOf("day");
  if (minutes >= 24 * 60) return day.plus({ days: 1 }).startOf("day").toMillis();
  // Set wall-clock fields (not elapsed minutes) so 09:00 stays 09:00 on DST transition days.
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 }).toMillis();
}

/** Merge overlapping or touching intervals. Returns a new sorted array. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

function rangesForDate(schedule: Schedule, date: string, weekday: Weekday, overrides: Map<string, DateOverride>): TimeRange[] {
  const override = overrides.get(date);
  if (override) return override.ranges;
  return schedule.weekly.filter((r) => r.day === weekday).flatMap((r) => r.ranges);
}

/**
 * Expand a schedule into concrete available intervals (UTC) that overlap [from, to).
 * Handles date overrides, "24:00" ends, and DST transitions in the schedule's zone.
 */
export function availableIntervals(schedule: Schedule, from: number, to: number): Interval[] {
  const zone = schedule.timezone;
  const overrides = new Map(schedule.overrides.map((o) => [o.date, o]));
  // Start one local day early so ranges that started yesterday (in another zone) are included.
  let cursor = DateTime.fromMillis(from, { zone }).startOf("day").minus({ days: 1 });
  const stop = DateTime.fromMillis(to, { zone }).startOf("day").plus({ days: 1 });
  const out: Interval[] = [];
  while (cursor <= stop) {
    const date = cursor.toISODate()!;
    const weekday = cursor.weekday as Weekday;
    for (const range of rangesForDate(schedule, date, weekday, overrides)) {
      if (!isValidTime(range.start) || !isValidTime(range.end)) continue;
      const startMin = minutesOf(range.start);
      const endMin = minutesOf(range.end);
      if (endMin <= startMin) continue;
      const start = localToInstant(date, startMin, zone);
      const end = localToInstant(date, endMin, zone);
      if (end > from && start < to) out.push({ start, end });
    }
    cursor = cursor.plus({ days: 1 });
  }
  return mergeIntervals(out);
}

/** True when [start, end) lies entirely inside one of the (merged, sorted) intervals. */
export function containedIn(intervals: Interval[], start: number, end: number): boolean {
  for (const i of intervals) {
    if (i.start <= start && end <= i.end) return true;
    if (i.start > start) break;
  }
  return false;
}

/** True when [start, end) overlaps any interval. Touching edges do not overlap. */
export function overlapsAny(intervals: Interval[], start: number, end: number): boolean {
  for (const i of intervals) {
    if (i.start < end && start < i.end) return true;
  }
  return false;
}

export function localDateKey(instant: number, zone: string): string {
  return DateTime.fromMillis(instant, { zone }).toISODate()!;
}

export function localWeekKey(instant: number, zone: string): string {
  const dt = DateTime.fromMillis(instant, { zone });
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}
