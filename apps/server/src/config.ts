import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public base URL, used in links, OAuth redirects and emails. Defaults to RENDER_EXTERNAL_URL on Render. */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Product name shown in the UI and emails. Companies can white-label here. */
  APP_NAME: z.string().default("Scheduler"),
  /** postgres://... for production, or pglite://<dir> / memory:// for an embedded database. */
  DATABASE_URL: z.string().default("pglite://./data/pglite"),
  /** Secret used to encrypt OAuth tokens and webhook secrets at rest. Required in production. */
  ENCRYPTION_KEY: optionalString,
  /** smtp://user:pass@host:587 or smtps://... When unset, emails are printed to the log. */
  SMTP_URL: optionalString,
  EMAIL_FROM: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  MICROSOFT_TENANT_ID: z.string().default("common"),
  /** Generic OpenID Connect single sign-on (Okta, Entra ID, Google Workspace, Keycloak, Authentik...). */
  OIDC_ISSUER: optionalString,
  OIDC_CLIENT_ID: optionalString,
  OIDC_CLIENT_SECRET: optionalString,
  /** Button label: "Continue with ...". Defaults to "Google" for Google sign-in, otherwise "SSO". */
  OIDC_DISPLAY_NAME: optionalString,
  /**
   * "Sign in with Google" using the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET calendar client, so the same
   * Google OAuth client serves both. Shorthand for OIDC_ISSUER=https://accounts.google.com.
   */
  GOOGLE_SIGN_IN: bool.default(false),
  /** Create accounts on first SSO login. */
  OIDC_AUTO_PROVISION: bool.default(true),
  /**
   * Accept SSO emails the identity provider does not mark as verified (no `email_verified: true` claim).
   * Only enable for a single-tenant IdP you control, such as Entra ID with a tenant-specific issuer.
   */
  OIDC_TRUST_UNVERIFIED_EMAIL: bool.default(false),
  /** Comma-separated email domains allowed to sign in via SSO, e.g. "acme.com,acme.io". */
  ALLOWED_EMAIL_DOMAINS: optionalString,
  /** Set to false to require SSO for everyone except the owner. */
  PASSWORD_LOGIN: bool.default(true),
  /**
   * Honor X-Forwarded-For from reverse proxies. "true" means one proxy in front of the app; a number is how
   * many proxies append to the header (for example 2 for a CDN plus a load balancer). "false" ignores it.
   */
  TRUST_PROXY: z
    .union([z.boolean(), z.string(), z.number()])
    .transform((v, ctx) => {
      if (typeof v === "boolean") return v ? 1 : 0;
      const s = String(v).trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return 1;
      if (["", "0", "false", "no", "off"].includes(s)) return 0;
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use true, false or a number of proxy hops (0-10)' });
        return z.NEVER;
      }
      return n;
    })
    .default(false),
  /** Run the background job worker in this process. Disable on extra web replicas if you like. */
  WORKER_ENABLED: bool.default(true),
  /** Directory with the built web app. Defaults to apps/web/dist. */
  WEB_DIST_DIR: optionalString,
  SESSION_DAYS: z.coerce.number().int().positive().default(30),
});

export const GOOGLE_ISSUER = "https://accounts.google.com";

export type Config = Omit<z.infer<typeof schema>, "OIDC_DISPLAY_NAME"> & {
  OIDC_DISPLAY_NAME: string;
  /** Which kind of SSO is configured; "google" gets Google's sign-in button and account chooser. */
  oidcProvider: "google" | "generic";
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  oidcEnabled: boolean;
  allowedEmailDomains: string[];
  emailFrom: string;
  secureCookies: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // On Render the public URL is known only after the service is created, and Render provides it at runtime.
  const parsed = schema.safeParse(env.APP_URL || !env.RENDER_EXTERNAL_URL ? env : { ...env, APP_URL: env.RENDER_EXTERNAL_URL });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  let encryptionKey = c.ENCRYPTION_KEY;
  if (!encryptionKey) {
    if (c.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32");
    }
    encryptionKey = "insecure-development-key-change-me-in-production";
  }
  if (c.GOOGLE_SIGN_IN) {
    if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) {
      throw new Error("GOOGLE_SIGN_IN=true needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/integrations.md)");
    }
    if (c.OIDC_ISSUER && c.OIDC_ISSUER.replace(/\/$/, "") !== GOOGLE_ISSUER) {
      throw new Error("Only one single sign-on provider is supported: set GOOGLE_SIGN_IN or OIDC_ISSUER, not both");
    }
    c.OIDC_ISSUER = GOOGLE_ISSUER;
    c.OIDC_CLIENT_ID = c.OIDC_CLIENT_ID ?? c.GOOGLE_CLIENT_ID;
    c.OIDC_CLIENT_SECRET = c.OIDC_CLIENT_SECRET ?? c.GOOGLE_CLIENT_SECRET;
  }
  const oidcProvider = c.OIDC_ISSUER?.replace(/\/$/, "") === GOOGLE_ISSUER ? "google" : "generic";
  return {
    ...c,
    OIDC_DISPLAY_NAME: c.OIDC_DISPLAY_NAME ?? (oidcProvider === "google" ? "Google" : "SSO"),
    oidcProvider,
    APP_URL: c.APP_URL.replace(/\/$/, ""),
    ENCRYPTION_KEY: encryptionKey,
    googleEnabled: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
    microsoftEnabled: Boolean(c.MICROSOFT_CLIENT_ID && c.MICROSOFT_CLIENT_SECRET),
    oidcEnabled: Boolean(c.OIDC_ISSUER && c.OIDC_CLIENT_ID),
    allowedEmailDomains: (c.ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    emailFrom: c.EMAIL_FROM ?? `${c.APP_NAME} <no-reply@${new URL(c.APP_URL).hostname}>`,
    secureCookies: c.APP_URL.startsWith("https://"),
  };
}
