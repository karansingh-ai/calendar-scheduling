# Scheduler

**Open-source scheduling for teams that you run inside your own company.** A self-hostable alternative to Calendly: booking pages, team scheduling, calendar sync, SSO, an audit log, webhooks and a REST API, under the Apache-2.0 license.

> "Scheduler" is a working name. Set `APP_NAME` to show your own product name in the UI and emails.

## Why

Hosted schedulers put the features companies actually need (SSO, SCIM, audit logs, data control) behind enterprise contracts and keep all data in their cloud. This project ships those controls in the open-source core, so any team can run it on its own infrastructure, in its own region, next to its own identity provider.

## Features

**Scheduling**
- One-on-one, **group** (seats), **collective** (everyone must be free) and **round-robin** event types
- Round robin by priority or **equal distribution with weights**, with the reason for every assignment stored on the booking
- Weekly hours with split ranges, date overrides, multiple schedules per person, any IANA time zone (DST-safe)
- Minimum notice, buffers before/after, custom start-time intervals, daily and weekly limits, rolling or fixed booking windows
- Custom booking questions (text, long text, phone, dropdown, checkbox)
- Double-booking protection: availability is re-checked inside a locked database transaction
- **Explainable availability**: ask the API why any time is not bookable (`BUSY`, `BUFFER_CONFLICT`, `DAILY_LIMIT`, `FAIRNESS`...)

**Booking experience**
- Public pages per person (`/jane`) and per team (`/team/sales`), mobile friendly, invitee time zone detection
- Invitees reschedule or cancel from a secure link; hosts can reschedule, cancel and mark no-shows
- Confirmation, reschedule, cancellation and reminder emails with `.ics` invites
- Website embed (inline or popup) with browser events for analytics; redirect to your own page after booking

**Calendars**
- Google Calendar and Microsoft 365 (conflict checks, writes events, creates Google Meet / Teams links)
- Any read-only ICS feed (iCloud, Fastmail, Proton, CalDAV exports), with recurring events
- Tokens encrypted at rest (AES-256-GCM)

**For IT and admins**
- OpenID Connect single sign-on (Okta, Entra ID, Google Workspace, Keycloak, Authentik...) with just-in-time provisioning and allowed email domains; optionally SSO-only
- Roles (owner, admin, member), teams with managers, invites, disable users
- **Audit log** of sign-ins, configuration and every booking change, with CSV export and no retention limit
- Signed webhooks with retries and delivery logs; personal API keys; OpenAPI spec
- White-label name, brand color and logo
- Runs as one container with PostgreSQL. An embedded database is available for trials.

## Quick start

### Try it locally (no database to install)

```bash
git clone <this repo> scheduler && cd scheduler
npm install
npm run build
npm start          # http://localhost:3000, data in ./data (embedded PostgreSQL)
```

Open http://localhost:3000, create the owner account, then set your availability and create an event type. Without SMTP configured, emails are printed to the console.

### Run it for your company (Docker Compose)

```bash
cp .env.example .env
# Set APP_URL, ENCRYPTION_KEY (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d
```

Put it behind your reverse proxy with HTTPS, then configure SMTP, SSO and calendar apps. The full guide is in [docs/self-hosting.md](docs/self-hosting.md).

## Documentation

| Topic | Where |
|---|---|
| Production deployment, upgrades, backups, scaling | [docs/self-hosting.md](docs/self-hosting.md) |
| Every environment variable | [docs/configuration.md](docs/configuration.md) |
| Google, Microsoft and SSO setup | [docs/integrations.md](docs/integrations.md) |
| REST API, webhooks and embedding | [docs/api.md](docs/api.md) and `/api/openapi.yaml` |
| Architecture and contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Reporting vulnerabilities | [SECURITY.md](SECURITY.md) |

## Architecture

```
packages/core   Pure TypeScript scheduling engine: availability windows, slots, limits, seats,
                collective and round-robin logic. No I/O; heavily unit tested.
apps/server     Hono HTTP API on Node.js, Drizzle ORM (PostgreSQL or embedded PGlite),
                OIDC, calendar providers, email, webhooks, Postgres-backed job queue.
apps/web        React + Vite + Tailwind single-page app: booking pages and the dashboard.
```

One process serves the API, the web app and the background worker. There is no Redis or other service to operate.

## Roadmap

Contributions are welcome on any of these:

- Routing forms (qualify and route leads to the right host or team)
- SCIM provisioning and directory group sync
- Zoom integration and CalDAV write support
- Workflows: SMS reminders and custom follow-ups
- Hosted MCP server so AI assistants can check availability and book
- Translations (i18n) and accessibility audit
- Payments (Stripe) for paid sessions
- Helm chart

## License

[Apache License 2.0](LICENSE). No CLA: contributions are accepted under the same license with a [DCO](https://developercertificate.org/) sign-off.
