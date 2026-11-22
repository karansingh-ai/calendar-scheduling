import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";
import { startWorker } from "./worker";

/** Load a .env file (current directory first, then the repository root) without overriding real env vars. */
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of [resolve(process.cwd(), ".env"), resolve(here, "../../../.env")]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

async function main() {
  loadDotEnv();
  const { ctx, database } = await bootstrap();
  const { config } = ctx;
  const app = createApp(ctx);
  const worker = config.WORKER_ENABLED ? startWorker(ctx) : null;

  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    console.log(`${config.APP_NAME} listening on http://${info.address}:${info.port} (public URL ${config.APP_URL})`);
    console.log(`Database: ${database.kind}. Email: ${config.SMTP_URL ? "SMTP" : "console (set SMTP_URL to send real email)"}.`);
    if (database.kind === "pglite" && config.NODE_ENV === "production") {
      console.warn("Using the embedded database. Point DATABASE_URL at PostgreSQL for production use.");
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await worker?.stop();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
