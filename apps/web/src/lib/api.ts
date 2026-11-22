export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status})`, err.details);
  }
  return json as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details?.length) return `${err.message}: ${err.details.map((d) => (d.path ? `${d.path} ${d.message}` : d.message)).join("; ")}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// Shared API types (mirrors the server's JSON).
export type Kind = "one_on_one" | "group" | "collective" | "round_robin";
export type LocationType = "google_meet" | "microsoft_teams" | "link" | "phone" | "in_person" | "custom";

export interface User {
  id: string;
  email: string;
  name: string;
  username: string;
  role: "owner" | "admin" | "member";
  timezone: string;
  welcomeMessage: string | null;
  hasPassword: boolean;
  disabled: boolean;
}

export interface Question {
  id: string;
  label: string;
  type: "text" | "textarea" | "phone" | "select" | "checkbox";
  required: boolean;
  options?: string[];
}

export interface Host {
  userId: string;
  name?: string;
  email?: string;
  priority: number;
  weight: number;
  scheduleId: string | null;
}

export interface EventType {
  id: string;
  ownerUserId: string | null;
  teamId: string | null;
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  durationMinutes: number;
  slotIntervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindow: { type: "rolling"; days: number } | { type: "range"; start: string; end: string } | null;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  seats: number | null;
  location: { type: LocationType; value?: string };
  questions: Question[];
  reminderMinutes: number[];
  rrStrategy: "maximize_availability" | "equal_distribution";
  rrMaxImbalance: number | null;
  redirectUrl: string | null;
  color: string;
  hidden: boolean;
  active: boolean;
  hosts: Host[];
}

export interface PublicEventType {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  durationMinutes: number;
  color: string;
  seats: number | null;
  questions: Question[];
  location: { type: LocationType; value?: string };
  hosts: { name: string }[];
  owner: { kind: "user"; name: string; username: string } | { kind: "team"; name: string; slug: string };
  redirectUrl: string | null;
  hostTimezone: string;
}

export interface Org {
  name: string;
  brandColor: string;
  logoUrl: string | null;
  appName: string;
}

export interface Booking {
  id: string;
  status: "confirmed" | "cancelled";
  title: string;
  start: string;
  end: string;
  eventType: { id: string; slug?: string; title?: string; kind?: Kind };
  hostUserId: string;
  hosts: { id: string; name: string; email: string }[];
  location: { type: LocationType; value?: string; joinUrl?: string };
  invitee: { name: string; email: string; timezone: string };
  answers: Record<string, string | boolean>;
  assignmentReason: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  rescheduledFromId: string | null;
  noShow: boolean;
  createdAt: string;
}

export interface Schedule {
  id: string;
  name: string;
  timezone: string;
  weekly: { day: number; ranges: { start: string; end: string }[] }[];
  overrides: { date: string; ranges: { start: string; end: string }[] }[];
  isDefault: boolean;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  members: { userId: string; role: "manager" | "member"; name: string; email: string }[];
}
