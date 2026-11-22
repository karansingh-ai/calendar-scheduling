# Configuration reference

All configuration is through environment variables. Invalid values stop the server at startup with a clear message.

## Core

| Variable | Default | Description |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Public base URL. Used for links, emails, OAuth redirects and CSRF origin checks. |
| `APP_NAME` | `Scheduler` | Product name in the UI and emails. |
| `DATABASE_URL` | `pglite://./data/pglite` | `postgres://user:pass@host:5432/db` for production. `pglite://<dir>` runs an embedded PostgreSQL stored on disk (trials, small teams). `memory://` is for tests. |
| `ENCRYPTION_KEY` | none (required in production) | Secret for AES-256-GCM encryption of OAuth tokens, ICS URLs and webhook secrets. Generate with `openssl rand -hex 32`. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `NODE_ENV` | `development` | Set to `production` in deployments. |

## Email

| Variable | Default | Description |
|---|---|---|
| `SMTP_URL` | none | `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465`. When unset, emails are written to the log. |
| `EMAIL_FROM` | `<APP_NAME> <no-reply@<APP_URL host>>` | Sender address. Use a domain with SPF/DKIM set up for your SMTP provider. |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `OIDC_ISSUER` | none | Issuer URL of your OpenID Connect provider. Enables SSO when set with `OIDC_CLIENT_ID`. |
| `OIDC_CLIENT_ID` | none | Client ID. |
| `OIDC_CLIENT_SECRET` | none | Client secret (omit for public clients using PKCE only). |
| `OIDC_DISPLAY_NAME` | `SSO` | Button label: "Continue with ...". |
| `OIDC_AUTO_PROVISION` | `true` | Create accounts on first SSO sign-in. When false, only invited users can sign in. |
| `ALLOWED_EMAIL_DOMAINS` | none | Comma-separated domains allowed to auto-provision, e.g. `acme.com,acme.io`. |
| `PASSWORD_LOGIN` | `true` | Set to `false` to require SSO for everyone except the owner (kept as break-glass access). |
| `SESSION_DAYS` | `30` | Session lifetime. |

## Calendars

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Enables Google Calendar and Google Meet. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | none | Enables Microsoft 365 / Outlook calendars and Teams meetings. |
| `MICROSOFT_TENANT_ID` | `common` | Use your tenant ID to restrict sign-in to your organization. |

ICS feeds need no configuration.

## Operations

| Variable | Default | Description |
|---|---|---|
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from your reverse proxy for client IPs. |
| `WORKER_ENABLED` | `true` | Run the background job worker (emails, reminders, webhooks) in this process. |
| `WEB_DIST_DIR` | `apps/web/dist` | Location of the built web app. |
| `MIGRATIONS_DIR` | `apps/server/drizzle` | Location of SQL migrations. |
