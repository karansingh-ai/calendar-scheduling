import type { Interval } from "@timebook/core";

export interface ExternalCalendar {
  externalId: string;
  name: string;
  primary: boolean;
  readOnly: boolean;
}

export interface CalendarEventInput {
  title: string;
  description: string;
  start: Date;
  end: Date;
  location?: string;
  /** Ask the provider to create a video meeting (Google Meet / Microsoft Teams). */
  video: boolean;
  requestId: string;
}

export interface CreatedEvent {
  externalEventId: string;
  joinUrl?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  accountEmail?: string;
}

/** A calendar provider that uses OAuth (Google, Microsoft). */
export interface OAuthCalendarProvider {
  id: "google" | "microsoft";
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  listCalendars(accessToken: string): Promise<ExternalCalendar[]>;
  getBusy(accessToken: string, calendarIds: string[], from: Date, to: Date): Promise<Interval[]>;
  createEvent(accessToken: string, calendarId: string, input: CalendarEventInput): Promise<CreatedEvent>;
  updateEvent(accessToken: string, calendarId: string, eventId: string, input: CalendarEventInput): Promise<void>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
}

export type FetchFn = typeof fetch;

export async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`${what} failed: HTTP ${res.status} ${body}`);
  }
  return res;
}

/** Decode a JWT payload without verifying it (only for tokens received directly from a provider over TLS). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
