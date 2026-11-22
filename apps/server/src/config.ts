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
  /** Public base URL, used in links, OAuth redirects and emails. */
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
  OIDC_DISPLAY_NAME: z.string().default("SSO"),
  /** Create accounts on first SSO login. */
  OIDC_AUTO_PROVISION: bool.default(true),
  /** Comma-separated email domains allowed to sign in via SSO auto-provisioning, e.g. "acme.com,acme.io". */
  ALLOWED_EMAIL_DOMAINS: optionalString,
  /** Set to false to require SSO for everyone except the owner. */
  PASSWORD_LOGIN: bool.default(true),
  /** Honor X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  TRUST_PROXY: bool.default(false),
  /** Run the background job worker in this process. Disable on extra web replicas if you like. */
  WORKER_ENABLED: bool.default(true),
  /** Directory with the built web app. Defaults to apps/web/dist. */
  WEB_DIST_DIR: optionalString,
  SESSION_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof schema> & {
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  oidcEnabled: boolean;
  allowedEmailDomains: string[];
  emailFrom: string;
  secureCookies: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
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
  return {
    ...c,
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
