# Self-hosting guide

This guide takes you from zero to a production deployment inside your company.

## What you need

| Component | Requirement |
|---|---|
| Runtime | Docker, Kubernetes, or Node.js 20.12+ |
| Database | PostgreSQL 14 or newer (16 recommended). Managed services (RDS, Cloud SQL, Azure Database) work. |
| Email | Any SMTP relay (SES, SendGrid, Postmark, Microsoft 365, Google Workspace relay) |
| HTTPS | A reverse proxy or load balancer that terminates TLS |
| Optional | An OpenID Connect identity provider; Google and/or Microsoft OAuth apps for calendar sync |

Sizing: a single container with 0.5 vCPU and 512 MB RAM comfortably serves hundreds of users. The database is small: bookings, schedules and audit entries.

## 1. Configure

```bash
cp .env.example .env
```

Set at least:

- `APP_URL`: the public HTTPS URL, for example `https://schedule.acme.com`
- `ENCRYPTION_KEY`: `openssl rand -hex 32`. Store it in your secret manager. It encrypts calendar tokens and webhook secrets; changing it later disconnects every calendar.
- `DATABASE_URL` (or `POSTGRES_PASSWORD` when using the bundled Compose database)
- `SMTP_URL` and `EMAIL_FROM`

See [configuration.md](configuration.md) for every option.

## 2. Run

### Docker Compose

```bash
docker compose up -d
docker compose logs -f app
```

The app runs database migrations automatically on start.

### Container only (existing PostgreSQL)

```bash
docker build -t timebook .
docker run -d --name timebook -p 3000:3000 --env-file .env \
  -e DATABASE_URL=postgres://user:pass@db.internal:5432/timebook timebook
```

Tagged releases also publish `ghcr.io/<owner>/<repo>:<version>` (see `.github/workflows/release.yml`).

### Kubernetes

Use the same image as a `Deployment` with:

- an env `Secret` holding `ENCRYPTION_KEY`, `DATABASE_URL`, `SMTP_URL` and OAuth secrets
- readiness and liveness probes on `GET /healthz`
- `TRUST_PROXY=true` behind your ingress

To run more than one replica, set `WORKER_ENABLED=false` on all but one Deployment, or leave it on everywhere: jobs are claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, so workers never process the same job twice. Rate limits are per process, so also rate limit `/api/public/` at the ingress.

### Bare Node.js

```bash
npm ci && npm run build
NODE_ENV=production node apps/server/dist/index.js
```

Run it under systemd, PM2 or your process manager of choice.

## 3. Reverse proxy

Terminate TLS and forward to port 3000. Set `TRUST_PROXY=true` so client IPs in the audit log and rate limiter come from `X-Forwarded-For`.

Example Caddyfile:

```
schedule.acme.com {
  reverse_proxy localhost:3000
}
```

Example nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Cookies are marked `Secure` automatically when `APP_URL` starts with `https://`.

## 4. First login

1. Open `APP_URL`. The first visitor creates the **owner** account and names the organization.
2. Under **Organization**, set the brand color and logo.
3. Under **People**, invite admins and members, or enable SSO so people can sign in directly.
4. Each person sets **Availability**, connects **Calendars**, and creates **Event types**.
5. Admins create **Teams** for shared round-robin and collective event types.

## 5. Single sign-on

See [integrations.md](integrations.md#single-sign-on-openid-connect). Typical company settings:

```
OIDC_ISSUER=...
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_AUTO_PROVISION=true
ALLOWED_EMAIL_DOMAINS=acme.com
PASSWORD_LOGIN=false   # owner keeps password access as a break-glass account
```

## Backups

Everything lives in PostgreSQL. Back it up with your standard tooling (`pg_dump`, managed snapshots, PITR) and keep `ENCRYPTION_KEY` alongside, stored separately and securely. Restoring requires both.

## Upgrades

1. Back up the database.
2. Pull or build the new image.
3. Restart. Migrations run automatically and are forward-only.

Read the release notes before upgrading across minor versions.

## Data and privacy

- All personal data stays in your database and your email provider.
- Calendar providers are contacted only to read busy times and write the events your users booked.
- Invitee data can be deleted by deleting bookings; a dedicated data-deletion endpoint is on the roadmap.
- The audit log has no automatic retention limit. Prune `audit_log` with your own policy if needed.

## Troubleshooting

| Symptom | Check |
|---|---|
| No emails | `SMTP_URL` set? Without it, emails go to the log. Check the `jobs` table for `failed` rows and `last_error`. |
| Calendar busy times ignored | **Calendars** page shows the last sync error. Tokens refresh automatically; reconnect if the refresh token was revoked. |
| SSO redirect error | The redirect URI registered with the IdP must be exactly `<APP_URL>/api/auth/oidc/callback`. |
| "Cross-origin request rejected" | `APP_URL` must match the URL in the browser, including scheme and port. |
| Times look shifted | Each schedule has its own time zone; check it on the **Availability** page. |
