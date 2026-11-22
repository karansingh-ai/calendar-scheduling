import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, Schema, any>;

export interface Database {
  db: Db;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../drizzle"), resolve(here, "../../drizzle"), resolve(process.cwd(), "drizzle")];
  const found = candidates.find((c) => existsSync(resolve(c, "meta/_journal.json")));
  if (!found) throw new Error(`Could not find migrations folder. Looked in: ${candidates.join(", ")}`);
  return found;
}

/**
 * Open a database from a URL.
 *  - postgres://user:pass@host:5432/db  -> PostgreSQL (recommended for production)
 *  - pglite://./data/pglite             -> embedded PostgreSQL (WASM) stored on disk; good for trials
 *  - memory://                          -> embedded, in-memory (tests)
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const client = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(client, { schema }) as unknown as Db;
    return {
      db,
      kind: "postgres",
      migrate: () => migratePostgres(db as never, { migrationsFolder: migrationsFolder() }),
      close: () => client.end({ timeout: 5 }),
    };
  }
  if (url.startsWith("pglite://") || url.startsWith("memory://")) {
    let dataDir: string | undefined;
    if (url.startsWith("pglite://")) {
      dataDir = resolve(url.slice("pglite://".length) || "./data/pglite");
      mkdirSync(dataDir, { recursive: true });
    }
    const client = new PGlite(dataDir);
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return {
      db,
      kind: "pglite",
      migrate: () => migratePglite(db as never, { migrationsFolder: migrationsFolder() }),
      close: () => client.close(),
    };
  }
  throw new Error(`Unsupported DATABASE_URL "${url}". Use postgres://, pglite:// or memory://`);
}

export { schema };
