import { loadConfig, type Config } from "./config";
import type { AppContext } from "./context";
import { openDatabase, type Database } from "./db";
import { Encrypter } from "./lib/crypto";
import { ConsoleMailer, SmtpMailer, type Mailer } from "./lib/mailer";
import { CalendarService } from "./services/calendars";
import type { FetchFn } from "./services/calendars/types";

export interface BootOptions {
  config?: Config;
  env?: Record<string, string | undefined>;
  mailer?: Mailer;
  fetch?: FetchFn;
  migrate?: boolean;
}

/** Open the database, run migrations and assemble the shared context. */
export async function bootstrap(opts: BootOptions = {}): Promise<{ ctx: AppContext; database: Database }> {
  const config = opts.config ?? loadConfig(opts.env);
  const database = await openDatabase(config.DATABASE_URL);
  if (opts.migrate !== false) await database.migrate();
  const encrypter = new Encrypter(config.ENCRYPTION_KEY!);
  const fetchFn = opts.fetch ?? fetch;
  const mailer = opts.mailer ?? (config.SMTP_URL ? new SmtpMailer(config.SMTP_URL, config.emailFrom) : new ConsoleMailer());
  const ctx: AppContext = {
    config,
    db: database.db,
    mailer,
    encrypter,
    fetch: fetchFn,
    calendars: new CalendarService(database.db, config, encrypter, fetchFn),
  };
  return { ctx, database };
}
