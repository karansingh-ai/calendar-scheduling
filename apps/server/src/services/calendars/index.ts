import type { Interval } from "@scheduler/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Config } from "../../config";
import type { Db } from "../../db";
import { bookingCalendarEvents, calendarConnections, calendars } from "../../db/schema";
import type { Encrypter } from "../../lib/crypto";
import { googleProvider } from "./google";
import { fetchIcsBusy } from "./ics";
import { microsoftProvider } from "./microsoft";
import type { CalendarEventInput, FetchFn, OAuthCalendarProvider, TokenSet } from "./types";

type Connection = typeof calendarConnections.$inferSelect;

const CACHE_TTL_MS = 60_000;

export class CalendarService {
  private providers = new Map<string, OAuthCalendarProvider>();
  private cache = new Map<string, { expires: number; value: Interval[] }>();

  constructor(
    private db: Db,
    private config: Config,
    private encrypter: Encrypter,
    private fetchFn: FetchFn,
  ) {
    if (config.googleEnabled) {
      this.providers.set("google", googleProvider(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!, fetchFn));
    }
    if (config.microsoftEnabled) {
      this.providers.set(
        "microsoft",
        microsoftProvider(config.MICROSOFT_CLIENT_ID!, config.MICROSOFT_CLIENT_SECRET!, config.MICROSOFT_TENANT_ID, fetchFn),
      );
    }
  }

  /** Allow tests to plug in a fake provider. */
  registerProvider(provider: OAuthCalendarProvider) {
    this.providers.set(provider.id, provider);
  }

  available() {
    return { google: this.providers.has("google"), microsoft: this.providers.has("microsoft"), ics: true };
  }

  provider(id: string): OAuthCalendarProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Calendar provider "${id}" is not configured on this server`);
    return p;
  }

  redirectUri(id: string) {
    return `${this.config.APP_URL}/api/integrations/${id}/callback`;
  }

  private async accessToken(conn: Connection): Promise<string> {
    if (!conn.accessTokenEnc) throw new Error("Connection has no access token");
    if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() > Date.now() + 30_000) {
      return this.encrypter.decrypt(conn.accessTokenEnc);
    }
    if (!conn.refreshTokenEnc) throw new Error("Access token expired and no refresh token is stored; reconnect the calendar");
    const tokens = await this.provider(conn.provider).refresh(this.encrypter.decrypt(conn.refreshTokenEnc));
    await this.db
      .update(calendarConnections)
      .set({
        accessTokenEnc: this.encrypter.encrypt(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken ? this.encrypter.encrypt(tokens.refreshToken) : conn.refreshTokenEnc,
        tokenExpiresAt: tokens.expiresAt,
        lastError: null,
        lastErrorAt: null,
      })
      .where(eq(calendarConnections.id, conn.id));
    return tokens.accessToken;
  }

  /** Store tokens from an OAuth callback and import the account's calendars. */
  async connectOAuth(userId: string, providerId: "google" | "microsoft", tokens: TokenSet): Promise<Connection> {
    const existing = tokens.accountEmail
      ? (
          await this.db
            .select()
            .from(calendarConnections)
            .where(
              and(
                eq(calendarConnections.userId, userId),
                eq(calendarConnections.provider, providerId),
                eq(calendarConnections.accountEmail, tokens.accountEmail),
              ),
            )
        )[0]
      : undefined;
    const values = {
      accessTokenEnc: this.encrypter.encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.encrypter.encrypt(tokens.refreshToken) : existing?.refreshTokenEnc ?? null,
      tokenExpiresAt: tokens.expiresAt,
      lastError: null,
      lastErrorAt: null,
    };
    let conn: Connection;
    if (existing) {
      [conn] = await this.db.update(calendarConnections).set(values).where(eq(calendarConnections.id, existing.id)).returning();
    } else {
      [conn] = await this.db
        .insert(calendarConnections)
        .values({ userId, provider: providerId, accountEmail: tokens.accountEmail ?? null, ...values })
        .returning();
    }
    await this.syncCalendars(conn);
    return conn;
  }

  async syncCalendars(conn: Connection) {
    const token = await this.accessToken(conn);
    const list = await this.provider(conn.provider).listCalendars(token);
    const current = await this.db.select().from(calendars).where(eq(calendars.connectionId, conn.id));
    const hasDestination = (await this.db.select().from(calendars).where(and(eq(calendars.userId, conn.userId), eq(calendars.isDestination, true)))).length > 0;
    for (const cal of list) {
      const found = current.find((c) => c.externalId === cal.externalId);
      if (found) {
        await this.db.update(calendars).set({ name: cal.name, readOnly: cal.readOnly }).where(eq(calendars.id, found.id));
      } else {
        await this.db.insert(calendars).values({
          connectionId: conn.id,
          userId: conn.userId,
          externalId: cal.externalId,
          name: cal.name,
          readOnly: cal.readOnly,
          checkConflicts: cal.primary,
          isDestination: cal.primary && !cal.readOnly && !hasDestination,
        });
      }
    }
  }

  async addIcsFeed(userId: string, url: string, name: string) {
    // Validate the feed before saving it.
    await fetchIcsBusy(this.fetchFn, url, new Date(), new Date(Date.now() + 86_400_000));
    const [conn] = await this.db
      .insert(calendarConnections)
      .values({ userId, provider: "ics", accountEmail: null, icsUrlEnc: this.encrypter.encrypt(url) })
      .returning();
    await this.db.insert(calendars).values({
      connectionId: conn.id,
      userId,
      externalId: "feed",
      name,
      readOnly: true,
      checkConflicts: true,
      isDestination: false,
    });
    return conn;
  }

  private async recordError(connId: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[calendar] connection ${connId}: ${message}`);
    await this.db
      .update(calendarConnections)
      .set({ lastError: message.slice(0, 500), lastErrorAt: new Date() })
      .where(eq(calendarConnections.id, connId));
  }

  /**
   * Busy time from every calendar marked "check for conflicts", grouped by user.
   * Provider failures are recorded on the connection and do not block scheduling.
   */
  async busyForUsers(userIds: string[], from: Date, to: Date): Promise<Map<string, Interval[]>> {
    const result = new Map<string, Interval[]>(userIds.map((id) => [id, []]));
    if (userIds.length === 0) return result;
    const rows = await this.db
      .select({ cal: calendars, conn: calendarConnections })
      .from(calendars)
      .innerJoin(calendarConnections, eq(calendars.connectionId, calendarConnections.id))
      .where(and(inArray(calendars.userId, userIds), eq(calendars.checkConflicts, true)));

    const byConn = new Map<string, { conn: Connection; ids: string[] }>();
    for (const r of rows) {
      const entry = byConn.get(r.conn.id) ?? { conn: r.conn, ids: [] };
      entry.ids.push(r.cal.externalId);
      byConn.set(r.conn.id, entry);
    }

    await Promise.all(
      [...byConn.values()].map(async ({ conn, ids }) => {
        const cacheKey = `${conn.id}:${ids.sort().join(",")}:${from.getTime()}:${to.getTime()}`;
        const cached = this.cache.get(cacheKey);
        let busy: Interval[];
        if (cached && cached.expires > Date.now()) {
          busy = cached.value;
        } else {
          try {
            if (conn.provider === "ics") {
              busy = await fetchIcsBusy(this.fetchFn, this.encrypter.decrypt(conn.icsUrlEnc!), from, to);
            } else {
              busy = await this.provider(conn.provider).getBusy(await this.accessToken(conn), ids, from, to);
            }
            this.cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value: busy });
            if (conn.lastError) {
              await this.db.update(calendarConnections).set({ lastError: null, lastErrorAt: null }).where(eq(calendarConnections.id, conn.id));
            }
          } catch (err) {
            await this.recordError(conn.id, err);
            busy = [];
          }
        }
        result.get(conn.userId)!.push(...busy);
      }),
    );
    return result;
  }

  clearCache() {
    this.cache.clear();
  }

  /** Create the event on each host's destination calendar. Returns the first video join URL, if any. */
  async createBookingEvents(bookingId: string, hostIds: string[], input: CalendarEventInput, videoHostId?: string): Promise<string | undefined> {
    let joinUrl: string | undefined;
    const dest = await this.db
      .select({ cal: calendars, conn: calendarConnections })
      .from(calendars)
      .innerJoin(calendarConnections, eq(calendars.connectionId, calendarConnections.id))
      .where(and(inArray(calendars.userId, hostIds), eq(calendars.isDestination, true)));
    for (const { cal, conn } of dest) {
      if (conn.provider === "ics") continue;
      try {
        const wantsVideo = input.video && conn.userId === (videoHostId ?? hostIds[0]);
        const created = await this.provider(conn.provider).createEvent(await this.accessToken(conn), cal.externalId, {
          ...input,
          video: wantsVideo,
        });
        await this.db.insert(bookingCalendarEvents).values({ bookingId, calendarId: cal.id, externalEventId: created.externalEventId });
        if (created.joinUrl && !joinUrl) joinUrl = created.joinUrl;
      } catch (err) {
        await this.recordError(conn.id, err);
      }
    }
    return joinUrl;
  }

  async deleteBookingEvents(bookingId: string) {
    const rows = await this.db
      .select({ ev: bookingCalendarEvents, cal: calendars, conn: calendarConnections })
      .from(bookingCalendarEvents)
      .innerJoin(calendars, eq(bookingCalendarEvents.calendarId, calendars.id))
      .innerJoin(calendarConnections, eq(calendars.connectionId, calendarConnections.id))
      .where(eq(bookingCalendarEvents.bookingId, bookingId));
    for (const { ev, cal, conn } of rows) {
      try {
        await this.provider(conn.provider).deleteEvent(await this.accessToken(conn), cal.externalId, ev.externalEventId);
        await this.db.delete(bookingCalendarEvents).where(eq(bookingCalendarEvents.id, ev.id));
      } catch (err) {
        await this.recordError(conn.id, err);
      }
    }
  }
}
