import type { Interval } from "@timebook/core";
import ical from "node-ical";
import { guardedFetch, readTextLimited, type ResolveHost } from "../../lib/outbound";
import type { FetchFn } from "./types";

const FEED_TIMEOUT_MS = 8_000;
const FEED_MAX_BYTES = 10_000_000;

/**
 * Read-only busy time from a published iCalendar feed (iCloud, Fastmail, Proton, Outlook "publish",
 * any CalDAV server's export URL...). Recurring events are expanded within the requested range.
 */
export async function fetchIcsBusy(fetchFn: FetchFn, resolveHost: ResolveHost, url: string, from: Date, to: Date): Promise<Interval[]> {
  const res = await guardedFetch(fetchFn, resolveHost, url.replace(/^webcal:\/\//i, "https://"), { headers: { accept: "text/calendar" } }, {
    timeoutMs: FEED_TIMEOUT_MS,
    maxRedirects: 3,
  });
  if (!res.ok) throw new Error(`ICS feed returned HTTP ${res.status}`);
  const text = await readTextLimited(res, FEED_MAX_BYTES);
  return busyFromIcs(text, from, to);
}

type VEvent = ical.VEvent & {
  transparency?: string;
  rrule?: { between(a: Date, b: Date, inc: boolean): Date[] };
  exdate?: Record<string, Date>;
  recurrences?: Record<string, ical.VEvent>;
};

function key(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function busyFromIcs(text: string, from: Date, to: Date): Interval[] {
  const data = ical.sync.parseICS(text);
  const out: Interval[] = [];
  const add = (start: Date, end: Date) => {
    if (end > from && start < to) out.push({ start: start.getTime(), end: end.getTime() });
  };
  for (const item of Object.values(data)) {
    if (!item || item.type !== "VEVENT") continue;
    const e = item as VEvent;
    if (!e.start) continue;
    if (e.transparency === "TRANSPARENT" || e.status === "CANCELLED") continue;
    const start = new Date(e.start as unknown as Date);
    const end = e.end ? new Date(e.end as unknown as Date) : new Date(start.getTime() + 24 * 3600_000);
    const duration = end.getTime() - start.getTime();
    if (e.rrule) {
      const lookback = new Date(from.getTime() - duration);
      for (const occ of e.rrule.between(lookback, to, true)) {
        const k = key(occ);
        if (e.exdate && Object.values(e.exdate).some((x) => key(new Date(x as unknown as Date)) === k)) continue;
        const override = e.recurrences?.[k];
        if (override) {
          if (override.status === "CANCELLED") continue;
          add(new Date(override.start as unknown as Date), new Date((override.end ?? override.start) as unknown as Date));
        } else {
          add(occ, new Date(occ.getTime() + duration));
        }
      }
    } else {
      add(start, end);
    }
  }
  return out;
}
