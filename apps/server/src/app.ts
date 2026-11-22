import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { csrf, loadUser, requireUser, type AppEnv } from "./auth/middleware";
import type { AppContext } from "./context";
import { errorResponse, notFound } from "./lib/http";
import { adminRoutes, teamRoutes } from "./routes/admin";
import { apiKeyRoutes, directoryRoutes, meRoutes, webhookRoutes } from "./routes/account";
import { authRoutes } from "./routes/auth";
import { bookingRoutes } from "./routes/bookings";
import { calendarRoutes, connectionRoutes, integrationRoutes } from "./routes/calendars";
import { eventTypeRoutes } from "./routes/eventTypes";
import { publicRoutes } from "./routes/public";
import { scheduleRoutes } from "./routes/schedules";

const here = dirname(fileURLToPath(import.meta.url));

function findFile(candidates: string[]) {
  return candidates.find((p) => existsSync(p));
}

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "strict-origin-when-cross-origin");
  });
  app.onError((err, c) => errorResponse(c, err));

  app.get("/healthz", async (c) => {
    await ctx.db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  const api = new Hono<AppEnv>();
  api.use("*", loadUser);
  api.use("*", csrf);
  api.use("*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  api.route("/auth", authRoutes);
  api.route("/public", publicRoutes);
  api.route("/integrations", integrationRoutes);

  const v1 = new Hono<AppEnv>();
  v1.use("*", requireUser);
  v1.route("/me", meRoutes);
  v1.route("/users", directoryRoutes);
  v1.route("/event-types", eventTypeRoutes);
  v1.route("/schedules", scheduleRoutes);
  v1.route("/bookings", bookingRoutes);
  v1.route("/calendars", calendarRoutes);
  v1.route("/calendar-connections", connectionRoutes);
  v1.route("/webhooks", webhookRoutes);
  v1.route("/api-keys", apiKeyRoutes);
  v1.route("/teams", teamRoutes);
  v1.route("/admin", adminRoutes);
  api.route("/v1", v1);

  const openapiPath = findFile([resolve(here, "../openapi.yaml"), resolve(here, "../../openapi.yaml"), resolve(process.cwd(), "openapi.yaml")]);
  api.get("/openapi.yaml", (c) => {
    if (!openapiPath) throw notFound();
    c.header("content-type", "application/yaml; charset=utf-8");
    return c.body(readFileSync(openapiPath, "utf8"));
  });
  api.all("*", () => {
    throw notFound("Unknown API route");
  });
  app.route("/api", api);

  // Web app (built by apps/web). Booking pages may be embedded on other sites; the dashboard may not.
  const webDir = ctx.config.WEB_DIST_DIR ?? findFile([resolve(here, "../../web/dist"), resolve(here, "../../../web/dist"), resolve(process.cwd(), "apps/web/dist")]);
  if (webDir && existsSync(resolve(webDir, "index.html"))) {
    const indexHtml = readFileSync(resolve(webDir, "index.html"), "utf8");
    app.use(
      "/assets/*",
      serveStatic({
        root: webDir,
        onFound: (_path, c) => {
          c.header("cache-control", "public, max-age=31536000, immutable");
        },
      }),
    );
    app.use("*", serveStatic({ root: webDir }));
    app.get("*", (c) => {
      const embeddable = !c.req.path.startsWith("/app") && !["/login", "/setup"].includes(c.req.path) && !c.req.path.startsWith("/invite");
      c.header(
        "content-security-policy",
        [
          "default-src 'self'",
          "img-src 'self' data: https:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self'",
          "connect-src 'self'",
          "base-uri 'self'",
          "form-action 'self'",
          `frame-ancestors ${embeddable ? "*" : "'self'"}`,
        ].join("; "),
      );
      c.header("cache-control", "no-cache");
      return c.html(indexHtml);
    });
  } else {
    app.get("/", (c) => c.text("API is running. Build the web app (npm run build) or run `npm run dev` for the UI."));
  }

  return app;
}
