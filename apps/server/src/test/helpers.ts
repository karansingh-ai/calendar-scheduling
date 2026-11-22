import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { MemoryMailer } from "../lib/mailer";
import { runDueJobs } from "../worker";

export const APP_URL = "http://localhost:3000";

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Boots the whole app on an in-memory embedded Postgres with captured email and outbound HTTP. */
export async function makeTestApp(env: Record<string, string> = {}) {
  const mailer = new MemoryMailer();
  const calls: FetchCall[] = [];
  const responders: { match: (url: string) => boolean; respond: (url: string, init?: RequestInit) => Response }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const r = responders.find((x) => x.match(url));
    if (r) return r.respond(url, init);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const { ctx, database } = await bootstrap({
    env: { NODE_ENV: "test", DATABASE_URL: "memory://", APP_URL, ...env },
    mailer,
    fetch: fakeFetch,
  });
  const app = createApp(ctx);

  return {
    app,
    ctx,
    mailer,
    calls,
    respond(match: (url: string) => boolean, respond: (url: string, init?: RequestInit) => Response) {
      responders.push({ match, respond });
    },
    runJobs: () => runDueJobs(ctx),
    client: () => new TestClient(app),
    close: () => database.close(),
  };
}

export class TestClient {
  cookie = "";
  bearer = "";
  constructor(private app: ReturnType<typeof createApp>) {}

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: APP_URL, ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookie) h.cookie = this.cookie;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    const res = await this.app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await res.text();
    let json: T;
    try {
      json = text ? JSON.parse(text) : (undefined as T);
    } catch {
      json = text as unknown as T;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  get<T = any>(path: string) {
    return this.req<T>("GET", path);
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.req<T>("POST", path, body);
  }
  patch<T = any>(path: string, body: unknown) {
    return this.req<T>("PATCH", path, body);
  }
  put<T = any>(path: string, body: unknown) {
    return this.req<T>("PUT", path, body);
  }
  del<T = any>(path: string) {
    return this.req<T>("DELETE", path);
  }
}

export const ALWAYS_OPEN = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, ranges: [{ start: "00:00", end: "24:00" }] }));

/** Midnight UTC, `days` from now. */
export function dayStart(days: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + days * 86_400_000);
}
