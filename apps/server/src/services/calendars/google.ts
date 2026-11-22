import type { Interval } from "@scheduler/core";
import { decodeJwtPayload, expectOk, type FetchFn, type OAuthCalendarProvider, type TokenSet } from "./types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

export function googleProvider(clientId: string, clientSecret: string, fetchFn: FetchFn): OAuthCalendarProvider {
  const tokenRequest = async (body: Record<string, string>): Promise<TokenSet> => {
    const res = await expectOk(
      await fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
      }),
      "Google token request",
    );
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      id_token?: string;
    };
    const email = json.id_token ? (decodeJwtPayload(json.id_token).email as string | undefined) : undefined;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
      accountEmail: email,
    };
  };

  const api = async (token: string, path: string, init: RequestInit = {}, what = "Google Calendar request") =>
    expectOk(
      await fetchFn(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      }),
      what,
    );

  const eventBody = (input: Parameters<OAuthCalendarProvider["createEvent"]>[2]) => ({
    summary: input.title,
    description: input.description,
    location: input.location,
    start: { dateTime: input.start.toISOString() },
    end: { dateTime: input.end.toISOString() },
    ...(input.video
      ? { conferenceData: { createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  });

  return {
    id: "google",
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${AUTH_URL}?${params}`;
    },
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      tokenRequest({ code, code_verifier: codeVerifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    refresh: (refreshToken) => tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" }),

    async listCalendars(token) {
      const res = await api(token, "/users/me/calendarList?minAccessRole=reader", {}, "Google calendar list");
      const json = (await res.json()) as { items?: { id: string; summary: string; primary?: boolean; accessRole: string }[] };
      return (json.items ?? []).map((c) => ({
        externalId: c.id,
        name: c.summary,
        primary: Boolean(c.primary),
        readOnly: !["owner", "writer"].includes(c.accessRole),
      }));
    },

    async getBusy(token, calendarIds, from, to): Promise<Interval[]> {
      if (calendarIds.length === 0) return [];
      const res = await api(
        token,
        "/freeBusy",
        {
          method: "POST",
          body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendarIds.map((id) => ({ id })) }),
        },
        "Google free/busy",
      );
      const json = (await res.json()) as { calendars: Record<string, { busy?: { start: string; end: string }[] }> };
      return Object.values(json.calendars ?? {}).flatMap((c) =>
        (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
      );
    },

    async createEvent(token, calendarId, input) {
      const res = await api(
        token,
        `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=none`,
        { method: "POST", body: JSON.stringify(eventBody(input)) },
        "Google create event",
      );
      const json = (await res.json()) as {
        id: string;
        hangoutLink?: string;
        conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
      };
      const video = json.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
      return { externalEventId: json.id, joinUrl: json.hangoutLink ?? video };
    },

    async updateEvent(token, calendarId, eventId, input) {
      const { conferenceData: _ignored, ...body } = eventBody(input) as Record<string, unknown>;
      await api(
        token,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: "PATCH", body: JSON.stringify(body) },
        "Google update event",
      );
    },

    async deleteEvent(token, calendarId, eventId) {
      const res = await fetchFn(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok && res.status !== 404 && res.status !== 410) await expectOk(res, "Google delete event");
    },
  };
}
