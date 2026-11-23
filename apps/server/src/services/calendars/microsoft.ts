import type { Interval } from "@timebook/core";
import { decodeJwtPayload, expectOk, type FetchFn, type OAuthCalendarProvider, type TokenSet } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "openid", "email", "User.Read", "Calendars.ReadWrite"];

export function microsoftProvider(clientId: string, clientSecret: string, tenant: string, fetchFn: FetchFn): OAuthCalendarProvider {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

  const tokenRequest = async (body: Record<string, string>): Promise<TokenSet> => {
    const res = await expectOk(
      await fetchFn(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: SCOPES.join(" "), ...body }),
      }),
      "Microsoft token request",
    );
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
    const claims = json.id_token ? decodeJwtPayload(json.id_token) : {};
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
      accountEmail: (claims.email as string) ?? (claims.preferred_username as string) ?? undefined,
    };
  };

  const graph = async (token: string, path: string, init: RequestInit = {}, what = "Microsoft Graph request") =>
    expectOk(
      await fetchFn(path.startsWith("http") ? path : `${GRAPH}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          prefer: 'outlook.timezone="UTC"',
          ...(init.headers ?? {}),
        },
      }),
      what,
    );

  const eventBody = (input: Parameters<OAuthCalendarProvider["createEvent"]>[2]) => ({
    subject: input.title,
    body: { contentType: "text", content: input.description },
    start: { dateTime: input.start.toISOString().replace("Z", ""), timeZone: "UTC" },
    end: { dateTime: input.end.toISOString().replace("Z", ""), timeZone: "UTC" },
    ...(input.location ? { location: { displayName: input.location } } : {}),
    ...(input.video ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  });

  return {
    id: "microsoft",
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: SCOPES.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      return `${base}/authorize?${params}`;
    },
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      tokenRequest({ code, code_verifier: codeVerifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    refresh: (refreshToken) => tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" }),

    async listCalendars(token) {
      const res = await graph(token, "/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100", {}, "Microsoft calendar list");
      const json = (await res.json()) as { value: { id: string; name: string; canEdit: boolean; isDefaultCalendar?: boolean }[] };
      return json.value.map((c) => ({
        externalId: c.id,
        name: c.name,
        primary: Boolean(c.isDefaultCalendar),
        readOnly: !c.canEdit,
      }));
    },

    async getBusy(token, calendarIds, from, to): Promise<Interval[]> {
      const out: Interval[] = [];
      for (const id of calendarIds) {
        let url: string | undefined =
          `${GRAPH}/me/calendars/${encodeURIComponent(id)}/calendarView?` +
          new URLSearchParams({
            startDateTime: from.toISOString(),
            endDateTime: to.toISOString(),
            $select: "start,end,showAs,isCancelled",
            $top: "500",
          });
        for (let page = 0; url && page < 10; page++) {
          const res = await graph(token, url, {}, "Microsoft calendar view");
          const json = (await res.json()) as {
            value: { start: { dateTime: string }; end: { dateTime: string }; showAs: string; isCancelled: boolean }[];
            "@odata.nextLink"?: string;
          };
          for (const e of json.value) {
            if (e.isCancelled || e.showAs === "free" || e.showAs === "workingElsewhere") continue;
            out.push({ start: Date.parse(`${e.start.dateTime}Z`), end: Date.parse(`${e.end.dateTime}Z`) });
          }
          url = json["@odata.nextLink"];
        }
      }
      return out;
    },

    async createEvent(token, calendarId, input) {
      const res = await graph(
        token,
        `/me/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: "POST", body: JSON.stringify(eventBody(input)) },
        "Microsoft create event",
      );
      const json = (await res.json()) as { id: string; onlineMeeting?: { joinUrl?: string } };
      return { externalEventId: json.id, joinUrl: json.onlineMeeting?.joinUrl };
    },

    async updateEvent(token, _calendarId, eventId, input) {
      const { isOnlineMeeting: _a, onlineMeetingProvider: _b, ...body } = eventBody(input) as Record<string, unknown>;
      await graph(token, `/me/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(body) }, "Microsoft update event");
    },

    async deleteEvent(token, _calendarId, eventId) {
      const res = await fetchFn(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 404) await expectOk(res, "Microsoft delete event");
    },
  };
}
