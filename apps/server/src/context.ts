import type { Config } from "./config";
import type { Db } from "./db";
import type { Encrypter } from "./lib/crypto";
import type { ResolveHost } from "./lib/outbound";
import type { Mailer } from "./lib/mailer";
import type { CalendarService } from "./services/calendars";
import type { FetchFn } from "./services/calendars/types";

/** Everything a request handler or job needs. Built once at startup (or per test). */
export interface AppContext {
  config: Config;
  db: Db;
  mailer: Mailer;
  encrypter: Encrypter;
  calendars: CalendarService;
  fetch: FetchFn;
  /** DNS lookup used to vet user-supplied URLs before requesting them. */
  resolveHost: ResolveHost;
}
