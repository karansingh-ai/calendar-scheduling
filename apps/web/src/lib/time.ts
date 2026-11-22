import { DateTime } from "luxon";
import type { LocationType } from "./api";

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let zones: string[] | null = null;
export function allTimeZones(): string[] {
  if (zones) return zones;
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    zones = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return zones;
}

export function fmtTime(iso: string, zone: string) {
  return DateTime.fromISO(iso, { zone }).toFormat("h:mm a");
}

export function fmtDate(iso: string, zone: string) {
  return DateTime.fromISO(iso, { zone }).toFormat("cccc, LLLL d, yyyy");
}

export function fmtRange(start: string, end: string, zone: string) {
  const s = DateTime.fromISO(start, { zone });
  const e = DateTime.fromISO(end, { zone });
  return `${s.toFormat("ccc, LLL d, yyyy")} · ${s.toFormat("h:mm a")} - ${e.toFormat("h:mm a")}`;
}

export function fmtDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export const LOCATION_LABELS: Record<LocationType, string> = {
  google_meet: "Google Meet",
  microsoft_teams: "Microsoft Teams",
  link: "Video link",
  phone: "Phone call",
  in_person: "In person",
  custom: "Custom",
};

export const KIND_LABELS = {
  one_on_one: "One-on-one",
  group: "Group",
  collective: "Collective",
  round_robin: "Round robin",
} as const;
