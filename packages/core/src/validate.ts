import { isValidTime, isValidTimeZone } from "./time";
import type { Schedule, TimeRange } from "./types";

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function checkRanges(ranges: TimeRange[], where: string, errors: string[]) {
  const parsed = [] as { s: number; e: number }[];
  for (const r of ranges) {
    if (!isValidTime(r.start) || !isValidTime(r.end)) {
      errors.push(`${where}: invalid time ${r.start}-${r.end} (use HH:MM, 00:00-24:00)`);
      continue;
    }
    const s = toMinutes(r.start);
    const e = toMinutes(r.end);
    if (e <= s) errors.push(`${where}: range ${r.start}-${r.end} must end after it starts`);
    parsed.push({ s, e });
  }
  parsed.sort((a, b) => a.s - b.s);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].s < parsed[i - 1].e) errors.push(`${where}: ranges overlap`);
  }
}

/** Returns a list of human-readable problems; an empty list means the schedule is valid. */
export function validateSchedule(schedule: Schedule): string[] {
  const errors: string[] = [];
  if (!isValidTimeZone(schedule.timezone)) errors.push(`Unknown time zone "${schedule.timezone}"`);
  const days = new Set<number>();
  for (const rule of schedule.weekly) {
    if (rule.day < 1 || rule.day > 7) errors.push(`Invalid weekday ${rule.day}`);
    if (days.has(rule.day)) errors.push(`Weekday ${rule.day} appears more than once`);
    days.add(rule.day);
    checkRanges(rule.ranges, `weekday ${rule.day}`, errors);
  }
  const dates = new Set<string>();
  for (const o of schedule.overrides) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) errors.push(`Invalid override date "${o.date}"`);
    if (dates.has(o.date)) errors.push(`Override date ${o.date} appears more than once`);
    dates.add(o.date);
    checkRanges(o.ranges, `override ${o.date}`, errors);
  }
  return errors;
}

export const DEFAULT_WEEKLY: Schedule["weekly"] = [1, 2, 3, 4, 5].map((day) => ({
  day: day as 1 | 2 | 3 | 4 | 5,
  ranges: [{ start: "09:00", end: "17:00" }],
}));
