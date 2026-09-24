# Star Billing Outreach

A production-ready Gmail outreach web app for **Star Billing**. An authorized user
connects their Gmail account through Google OAuth, uploads a CSV lead list, composes a
personalized outreach email, and sends it through the **official Gmail API** with a
controlled, conservative send queue.

Built with Next.js (App Router), TypeScript, Tailwind CSS, PostgreSQL, Prisma,
Google OAuth 2.0 and the Gmail API.

## Features

- **Google OAuth 2.0** — connect/disconnect a Gmail account, display the account email,
  auto token refresh, PKCE + state protection, encrypted token storage. No passwords
  are ever stored or submitted.
- **Lead management** — CSV import with a validation preview (missing fields, bad
  emails, duplicates inside the file **and** against existing leads), search/filter/sort,
  delete, and CSV export with formula-injection protection.
- **Email composer** — templates with `{{first_name}}`, `{{last_name}}`, `{{email}}`,
  `{{practice_name}}` variables and a live preview against a sample lead.
- **Campaigns** — create a draft, pick a from-account and template, preview recipients,
  start with a confirmation step (count, account, subject, estimated duration), then
  pause / resume / stop.
- **Sending system** — official Gmail API only. A dedicated worker drains the queue with
  per-account pacing, exponential-backoff retries for **temporary** errors, and immediate
  permanent failure for bad recipients. Respects suppression before every send.
- **Message log** — one row per recipient with campaign, lead, recipient, subject,
  status, attempts, error, and timestamps.
- **Suppression & opt-out** — suppression list in Settings; every email carries a
  `List-Unsubscribe` header and a one-click unsubscribe link.
- **Dashboard** — account/lead/campaign counts, sent/failed/pending metrics,
  suppressed contacts, and per-campaign performance.
- **Security** — signed HttpOnly session cookies, server-side ownership checks, CSRF
  origin checks, API rate limiting, encrypted OAuth tokens, no secret leakage to the
  browser.

## Tech stack

- Next.js **14** (App Router) + TypeScript (strict)
- Tailwind CSS
- PostgreSQL + **Prisma** ORM
- `googleapis` (official Gmail API + OAuth2), PKCE flow
- `jose` (session JWTs), `zod` (validation), `papaparse` (CSV)
- Vitest for tests, `tsx` for the worker

## Quick start

Requires **Node 20+** and a **PostgreSQL** instance.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
Copy-Item .env.example .env   # then edit (see below)

# 3. Create the database schema
npx prisma migrate deploy     # or: npm run db:push

# 4. Seed the admin user + sample leads/template
npm run db:seed

# 5. Run the app
npm run dev                   # http://localhost:3000

# 6. In a second terminal, start the send worker
npm run worker
```

Log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. Change the password
in `.env`, re-run `npm run db:seed`, and it updates.

## Environment variables

See `.env.example`. Key items:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `APP_URL` | Public app URL (OAuth redirects + unsubscribe links) |
| `SESSION_SECRET` | JWT signing key (≥32 chars) |
| `TOKEN_ENCRYPTION_KEY` | AES-256 key (≥32 chars) for OAuth tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google Cloud OAuth |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | First app user (seeded) |
| `SENDER_NAME` | Display name on sent emails |
| `SEND_INTERVAL_SECONDS` | Seconds between emails (default 45 — conservative) |
| `POLL_INTERVAL_SECONDS` | Worker poll rate (default 20) |
| `MAX_RETRIES` / `RETRY_BASE_DELAY_SECONDS` | Retry budget / backoff base |

Generate secrets with:

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

## Google Cloud OAuth setup

1. Go to https://console.cloud.google.com/ and create a project (e.g. `star-billing-outreach`).
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External, add your app name + email,
   and add scope **`https://www.googleapis.com/auth/gmail.send`** (the minimum needed).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   choose **Web application**.
5. Add an **Authorized redirect URI**: `https://YOUR_DOMAIN/api/google/callback`
   (use `http://localhost:3000/api/google/callback` for local development).
6. Copy the **Client ID** and **Client Secret** into `.env`.
7. Restart the app, go to **Settings → Connect Gmail** and complete the consent flow.

You only need the `gmail.send` scope — the app displays the account address returned by
the Gmail profile endpoint.

## Sending & the worker

Campaigns are drained by a dedicated worker process (`npm run worker`) that polls
PostgreSQL, respects per-account pacing, and updates the message log. Start it once per
application instance:

- `start` builds recipient rows from your leads (suppressed leads are marked `skipped`),
  sets the campaign `active`, and the worker begins sending.
- Temporary failures (429, 5xx, network) retry with exponential backoff up to `MAX_RETRIES`.
- Permanent failures (invalid recipient, revoked grant) fail immediately and are never retried.
- When no recipients remain pending, the campaign flips to `completed`.

The interval pacing is conservative **on purpose** for deliverability. Gmail's API quota
also applies on top of your configured pacing.

### Deployment note (multi-instance)

The worker uses an in-process pacing clock, so run **one** worker. For horizontal
scaling, move pacing into the database (e.g. `nextAttemptAt` fields) or use a scheduler —
the schema already supports per-recipient `nextAttemptAt` for that.

## Database & migrations

- `prisma/schema.prisma` is the source of truth.
- `prisma/migrations/` contains the committed initial migration.
- New development: `npx prisma migrate dev --name <change>`
- Production: `npx prisma migrate deploy`
- Alternative to migrations: `npm run db:push` (schema sync, no migration files).

## Tests

```bash
npm test          # 50 unit tests — CSV validation, dedupe, personalization,
                  # suppression, campaign building, send classification/backoff,
                  # token encryption, message building, OAuth refresh, authz
```

Core logic lives in `src/lib/` as pure functions so it can be tested without a database.

## Production deployment

Recommended: a VPS or container platform with **two long-running processes**:

1. **Web server:** `npm run build && npm run start`
2. **Worker:** `npm run worker`

Set `NODE_ENV=production` and ensure `APP_URL` is `https://…`. Use a managed Postgres
(e.g. Supabase, Neon, RDS) and add the app URL to the Google project instead of
`localhost`.

Example `Procfile` (Heroku / Render):

```
web: npm run start
worker: npm run worker
```

Reverse-proxy behind HTTPS (the session + OAuth cookies are `secure` in production).
Back up the database; nothing else stores state.

## Compliance & limits

- Uses the **official Gmail API** — no browser automation, no password storage, no
  circumvention of Gmail's sending limits.
- Per-account pacing is configurable but defaults are deliberately conservative.
- Every message includes `List-Unsubscribe` and a one-click unsubscribe page that writes
  straight to the suppression list.
- Retries are limited and only for temporary errors; permanent errors are surfaced in
  the message log for review.

## Project structure

```
prisma/            schema, migration, seed
scripts/worker.ts  send queue worker entrypoint
src/app/           App Router pages + API routes
src/components/    UI components (client-side interactivity)
src/lib/           business logic: auth, gmail, csv, campaigns, queue, security
tests/             Vitest unit tests
```