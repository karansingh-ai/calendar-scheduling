# Contributing

Thanks for helping. This project aims to be the scheduling tool companies are comfortable running themselves, so correctness, security and operability matter more than feature count.

## Development setup

Requirements: Node.js 20.12+ (22 recommended). No database is needed for development: the server uses an embedded PostgreSQL by default.

```bash
npm install
npm run dev        # API on :3000 (auto-reload), web app on :5173 with a proxy to the API
```

Open http://localhost:5173 and create the owner account. Emails are printed in the server console.

The server reads a `.env` file from the repository root if present (real environment variables win). For development, set `APP_URL=http://localhost:5173` there so links in emails and OAuth redirects point at the Vite dev server.

## Tests

```bash
npm test                     # engine unit tests + full API integration tests (embedded PostgreSQL)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/scheduler_test npm test   # against real PostgreSQL (the database is wiped)
npm run typecheck
```

CI runs both test modes. Please add tests with every behavior change:

- Scheduling rules belong in `packages/core` with unit tests in `slots.test.ts`. Include DST and multi-time-zone cases when relevant.
- API behavior belongs in `apps/server/src/app.test.ts`, which drives the real HTTP app.

## Project layout

```
packages/core/src
  slots.ts         candidate generation and per-host checks (hours, busy, buffers, limits, seats, fairness)
  roundRobin.ts    host assignment strategies
  time.ts          time zone and interval helpers
apps/server/src
  routes/          HTTP handlers (Hono), one file per area
  services/        availability, bookings, calendars, notifications, webhooks, jobs, audit
  auth/            sessions, API keys, CSRF, OpenID Connect
  db/schema.ts     Drizzle schema; run `npm run db:generate` after changing it
apps/web/src
  components/Booker.tsx   the booking widget
  pages/                  public pages, auth pages and the dashboard
```

## Database changes

Edit `apps/server/src/db/schema.ts`, then:

```bash
npm run db:generate -w @scheduler/server -- --name short_description
```

Commit the generated SQL in `apps/server/drizzle`. Migrations must be forward-only and safe to run on a live database.

## Pull requests

- Keep PRs focused, with a clear description of the user-facing change.
- Run `npm test` and `npm run typecheck`.
- Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/). There is no CLA; contributions are licensed under Apache-2.0 like the rest of the project.

## Code of conduct

Participation is governed by the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Report unacceptable behavior to the maintainers through the contact listed in [SECURITY.md](SECURITY.md).
