# Leo Outreach Tool — Deployment Runbook

**Install dir:** `C:\deploy\Leo-outreach-tool`
**URL:** https://res-subjective-labeled-come.trycloudflare.com  (Cloudflare Quick Tunnel — temporary, changes on tunnel restart)
**Local:** http://localhost:3010  (LAN: http://192.168.1.4:3010 — login blocked by design, see §7)
**Stack:** Next.js 14.2.35 (App Router) + Prisma 5.22 + PostgreSQL 18.4 (Windows service `LeoPostgres`)
**Managed by:** PM2 7.0.4

> This is a **Windows 11 Pro** host, not Linux. There is no `/var/www`, no
> systemd, and no UFW. Persistence is done with a Windows Startup-folder entry
> instead of `pm2 startup`.

---

## 1. Process architecture

**PostgreSQL is not a PM2 process.** It runs as the Windows service
`LeoPostgres` — Session 0, port 5438, data dir
`C:\deploy\Leo-outreach-tool.old\.pgdata`, account `NT AUTHORITY\NetworkService`,
owned by the Service Control Manager. PM2 manages only the three application
processes:

| PM2 name             | What it is                    | Binds to            |
|----------------------|-------------------------------|---------------------|
| `leo-outreach`       | Next.js production web server | `0.0.0.0:3010`      |
| `leo-outreach-worker`| Send-queue worker (1 only)    | none (no listener)  |
| `leo-outreach-warmup`| Mailbox warm-up worker        | none (no listener)  |

Defined in `ecosystem.config.cjs`. Logs in `logs\`.

```powershell
Get-Service LeoPostgres        # read-only status (works unelevated)
Start-Service LeoPostgres      # requires an elevated shell
Stop-Service  LeoPostgres      # requires an elevated shell
Get-NetTCPConnection -LocalPort 5438 -State Listen
```

> Never start PostgreSQL with `node scripts/dev-db.mjs`, `pm2 start leo-db` or
> any other launcher. The `leo-db` PM2 entry, `scripts/dev-db.mjs` and
> `scripts/lib/pg-supervisor.mjs` were removed on 2026-10-06. Running
> PostgreSQL from PM2 -> node.exe -> postgres.exe puts it in the interactive
> console session, which is what produced the conhost popup windows and the
> `0xC000013A` child kills recorded below.

> ### ⚠️ Incident history: `leo-db` reported "online" while PostgreSQL was dead
>
> *(Kept as history — this describes the architecture that has since been
> replaced. Do not follow the `pm2 restart leo-db` advice below; use
> `Start-Service LeoPostgres`.)*
>
> The old `scripts\dev-db.mjs` called `pg.start()` **once** and then parked on
> a `setInterval` — it never watched the `postgres.exe` child. If PostgreSQL
> died, the wrapper stayed alive, PM2 kept showing `online`, and nothing
> restarted it. The app then failed with
> `Can't reach database server at localhost:5438` and the worker crash-looped.
>
> **Check the database itself, not the process status:**
>
> ```powershell
> Get-Process postgres -ErrorAction SilentlyContinue   # empty = DB is DOWN
> Get-NetTCPConnection -LocalPort 5438 -State Listen -ErrorAction SilentlyContinue
> ```
>
> **Recover (as of 2026-10-06):** `Start-Service LeoPostgres` from an elevated
> shell — `pm2 restart leo-db` no longer exists. Then confirm a listening
> socket and `LOG: database system is ready to accept connections` in the
> service log. PostgreSQL replays WAL on start, so committed data is safe; no
> restore needed.
> The worker and web app reconnect on their own once the port is back — no
> restart of those is required.
>
> Seen on 2026-09-29 **four times in one morning**, each time a different child
> process, so this is a recurring pattern rather than a one-off:
>
> | Time  | Child killed                                  | Exception      |
> |-------|-----------------------------------------------|----------------|
> | 09:26 | client backend running `CREATE DATABASE`      | `0xC000013A`   |
> | 10:22 | background worker `logical replication launcher` | `0xFFFFFFFF` |
> | 11:25 | background worker `autovacuum launcher`        | `0xFFFFFFFF`  |
> | 11:26 | client backend running a `Campaign` query      | `0xC000013A`   |
>
> `0xC000013A` is `STATUS_CONTROL_C_EXIT` — a console Ctrl+C, not a crash.
> PostgreSQL responds to any abnormal child exit by tearing down the whole
> cluster (`terminating any other active server processes`), so one killed
> backend takes the database down with it.
>
> **Observed correlation:** the database stayed up for many minutes when
> nothing was connected, and died within seconds of a client connecting. The
> `0xC000013A` kills are the signature of a console-wide interrupt reaching
> postgres backends, which points at something in the shell/console session
> rather than at PostgreSQL itself. `SentinelOne` (`SentinelAgent` and four other
> services) is installed and is a plausible alternative suspect for the
> `0xFFFFFFFF` kills; **not proven** — Windows process auditing (Security event
> 4689) is disabled, so no kill trace could be captured. Enabling process
> termination auditing is the next diagnostic step if this recurs.
>
> **Permanent fix — implemented 2026-10-06:** PostgreSQL was moved out of PM2
> entirely and now runs as the Windows service `LeoPostgres` in Session 0. A
> service is started and supervised by the Service Control Manager, so there is
> no console session for a Ctrl+C to travel down, and no node wrapper that can
> report `online` over a dead server. `sc failure` is configured to restart it
> after 5s / 15s / 60s. See §6.

## 2. Common commands

> ### `ALLOWED_ORIGINS` — working while the tunnel is down
>
> `assertSameOrigin` (`src\lib\http.ts`) is the CSRF guard on **all 59**
> state-changing routes (settings save, campaign start/pause/resume/stop, Gmail
> disconnect, leads, templates, groups, SMS…). It compares the browser's
> `Origin` header against `APP_URL`. If you browse from anywhere other than
> `APP_URL`, every write returns **403 Forbidden** — including login.
>
> `APP_URL` is a Cloudflare Quick Tunnel URL and **cannot** simply be pointed at
> `localhost`, because `src\lib\suppression.ts` builds the unsubscribe link as
> `${APP_URL}/unsubscribe?...`. Setting `APP_URL` to `localhost` would put a
> dead opt-out link in every email, which is a CAN-SPAM problem for a bulk
> mailer. `APP_URL` must therefore stay the public origin.
>
> Instead, `.env` has:
>
> ```
> ALLOWED_ORIGINS="http://localhost:3010,http://192.168.1.5:3010"
> ```
>
> Comma-separated extra origins. `APP_URL` is always accepted and need not be
> listed. This is an **explicit allowlist**, deliberately not "trust the Host
> header" — never widen it to untrusted hosts.
>
> Only the exact origins listed are accepted. Adding this PC's IP does **not**
> open the subnet: `http://192.168.1.99:3010` still returns 403 (verified
> 2026-10-02). Keep it that way — do not add wildcards or "trust the Host header".
>
> **No rebuild is needed.** This was previously (and wrongly) documented as
> requiring one. `ALLOWED_ORIGINS` is read from the process environment at
> request time and is *not* baked into PM2's env, so Next.js re-reads `.env` on
> its own. Verified: `pm2 env 1` has no `ALLOWED_ORIGINS` entry, and after only
> `pm2 restart leo-outreach` the new origin returned 200. Just:
>
> ```
> pm2 restart leo-outreach        # the web app only
> ```
>
> Do **not** restart the worker for this, and never `cloudflared` or
> `LeoPostgres` — the database is a Windows service, not a PM2 app.
>
> **The LAN entry is a DHCP address and can go stale.** If the router hands this
> PC a different IP after a reconnect, saves from your phone will 403 again.
> Check with `ipconfig`, update the line, `pm2 restart leo-outreach`.
> Confirm with `node scripts\verify-origin-allowlist.mjs`, which prints the whole
> allow/block matrix.
>
> ### Reaching the app from a phone or another laptop
>
> The web server already binds `0.0.0.0:3010` (`next start -p 3010 -H 0.0.0.0`
> in `ecosystem.config.cjs`), so it is reachable on the LAN at
> **http://192.168.1.5:3010**. Nothing needed changing to expose the port — only
> the origin allowlist above.
>
> Windows Firewall: the Wi-Fi network profile on this host is **Public**, but the
> `node.exe` inbound allow rule that covers
> `…\nodejs\node-v24.21.0-win-x64\node.exe` (the exact binary PM2 runs) is
> enabled on the Public profile, and there are no inbound block rules. So the port
> is open on this profile. If a device still cannot connect, the fix is to set
> the Wi-Fi profile to **Private** (Settings → Network → Wi-Fi → Security) — not
> to add a blanket firewall exception.
>
> Note this is plain HTTP on a trusted home network. Do not port-forward 3010 on
> the router; use the Cloudflare tunnel for anything off-LAN.
>
> Verify with `node scripts\verify-origin-allowlist.mjs` — it re-saves the
> current settings unchanged and asserts that localhost and `APP_URL` are
> accepted while a foreign origin and `Origin: null` are still rejected.
>
> This does **not** fix the Gmail "Add account" / "Reconnect" buttons: those
> redirect to `GOOGLE_REDIRECT_URI`, which must be a real registered URI in
> Google Cloud Console. Restoring the tunnel is the only fix for those.

## 2. Common commands

Node is **not** on the system PATH. Either open a new PowerShell with the
Startup-folder env applied, or prefix:

```powershell
$env:PATH="C:\Users\Lenovo\AppData\Local\Programs\nodejs\node-v24.21.0-win-x64;$env:PATH"
cd C:\deploy\Leo-outreach-tool
```

```powershell
pm2 list                 # status of all three
pm2 logs leo-outreach    # tail web logs
pm2 logs leo-outreach-worker
pm2 logs leo-outreach-warmup
pm2 restart leo-outreach          # restart just the web app
pm2 restart leo-outreach-worker   # restart just the worker
pm2 restart ecosystem.config.cjs  # restart all three
pm2 stop ecosystem.config.cjs     # stop all three
pm2 save                          # persist the list (do this after changes)
pm2 resurrect                     # bring back everything after a crash

Get-Service LeoPostgres           # database status (never `pm2 ... leo-db`)
```

## 3. Start order matters

The worker, warm-up and web processes all need the database, and PostgreSQL is
a Windows service rather than a PM2 app, so **PM2 cannot start it for you**.
Start the service first:

```powershell
Start-Service LeoPostgres         # elevated shell
pm2 start ecosystem.config.cjs    # then the three application processes
```

## 4. Auto-start after reboot

Windows Startup folder entry:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LeoOutreach.cmd
```

At logon it checks whether port 3010 is listening; if not it runs
`pm2 resurrect` using the list saved by `pm2 save`. Output is appended to
`logs\startup.log`.

> It only runs at **user logon**, not at machine boot. Nobody logging in means
> the app stays down. If you need it up before logon, that needs an elevated
> (admin) scheduled task, which this account cannot create.

## 5. Migrations

```powershell
npx prisma migrate deploy     # apply, never reset
npx prisma migrate status     # check
```

> **Repository defect (fixed here):** the 6 committed migrations only ever
> created 9 of the 17 models in `schema.prisma`. `MicrosoftAccount`,
> `SmtpAccount`, `SmsCampaign`, `Contact`, `Message`, `Reply`, `WebhookEvent`
> and `SmsTemplate` were never migrated, so `/dashboard` returned HTTP 500
> with `P2021: table public.MicrosoftAccount does not exist`. The author's own
> `runpush.cmd` masked this by using `prisma db push --accept-data-loss`.
>
> Migration `20260928000000_add_missing_sms_smtp_microsoft_models` was added to
> fix that. Verified with
> `prisma migrate diff --from-schema-datasource ... --to-url ... --exit-code`
> → "No difference detected".
>
> If you add models, run `npx prisma migrate dev --name <change>` and commit the
> generated folder, otherwise the drift returns.

## 6. Database

* Server: PostgreSQL 18.4 running as the **Windows service `LeoPostgres`**
  (Session 0, port 5438, account `NT AUTHORITY\NetworkService`).
* Data directory: `C:\deploy\Leo-outreach-tool.old\.pgdata` — **back this up.**
  The service's `binPath` points here; the fresh clone has no `.pgdata`.
* Independent backup: `C:\deploy\Leo-outreach-pgdata-backup` (1792 files,
  78,790,535 bytes — byte-identical to the live cluster as of 2026-10-06).
* Database `star_billing_outreach`, user `postgres`, password `postgres`.
* It was created with `ENCODING 'UTF8'`; the old embedded build otherwise
  created clusters in the machine locale (WIN1252 here) and non-Latin1 text
  fails.
* `DATABASE_URL` is only in `.env`. Remote connections are refused — `pg_hba`
  requires `host all all 127.0.0.1/32 password`, i.e. local only, with a
  password.
* The service binaries live in
  `C:\deploy\Leo-outreach-tool.old\node_modules\@embedded-postgres\windows-x64\native\bin`
  (`postgres.exe`, `pg_ctl.exe`, `initdb.exe`). The fresh clone's `node_modules`
  copy exists only for the throwaway **test** clusters.

To back up:

> That build ships only `initdb.exe`, `pg_ctl.exe` and `postgres.exe` — **there
> is no `pg_dump.exe`**. Any `pg_dump` command you find online will fail on this
> host. Back up either by copying the data directory while the service is
> stopped, or with a logical export. This is what was used before the Groups
> migration:

```powershell
# Logical export, with encrypted OAuth tokens redacted.
# (a tsx script using ./src/lib/prisma; see git history for the exact file)
```

```powershell
# Or a physical copy: stop the SERVICE first so the copy is consistent.
# (elevated shell - and never `pm2 stop leo-db`, that app no longer exists)
Stop-Service LeoPostgres
Copy-Item -Recurse C:\deploy\Leo-outreach-tool.old\.pgdata `
  "C:\backup\pgdata-$(Get-Date -Format yyyyMMdd-HHmmss)"
Start-Service LeoPostgres
```

## 7. Configuration notes

* `.env` holds real generated secrets. Back it up; losing it loses the ability
  to decrypt stored OAuth tokens.
* `APP_URL` is the **public Cloudflare Quick Tunnel URL**, currently
  `https://res-subjective-labeled-come.trycloudflare.com`, and
  `GOOGLE_REDIRECT_URI` must match it as `/api/google/callback`. It **must**
  match the origin typed in the browser — `assertSameOrigin()` in
  `src/lib/http.ts` rejects mismatched `Origin` headers.
* Quick Tunnel URLs are **temporary and change every time `cloudflared`
  restarts**. If the URL changes you must update *both* `APP_URL` and
  `GOOGLE_REDIRECT_URI` in `.env`, register the new callback URL in Google
  Cloud Console, then `pm2 restart leo-outreach leo-outreach-worker`.
* Session cookies are `secure` because `APP_URL` starts with `https`, so
  **plain-HTTP local login on `http://localhost:3010` will not work** — that is
  expected, not a fault.
* Admin login is in `.admin-credentials.txt`. Change it, then re-run
  `npx prisma db seed` to update the stored password hash.

## 8. Known dependency advisories

`npm ci` reported 16 advisories (8 moderate, 6 high, 2 critical) in the
**committed lockfile**. Nothing was upgraded on purpose. Review with
`npm audit` before changing anything.

## 9. Contact groups (added 2026-09-28)

Contacts can be organised into named groups. Migration
`20260928020000_add_lead_groups` added:

| Table           | Purpose                                                        |
|-----------------|----------------------------------------------------------------|
| `Group`         | A named segment. Unique per `(userId, name)`.                  |
| `LeadGroup`     | Join table, unique per `(groupId, leadId)`.                    |
| `Campaign.recipientGroupId` | Nullable FK to `Group`, `ON DELETE SET NULL`.      |

Design notes worth knowing before you change it:

* **Membership is many-to-many, and it is a join table on purpose.** A contact
  is stored once in `Lead` (unique on `[userId, email]`) and referenced by any
  number of `LeadGroup` rows. Importing an existing email into a new group
  links the existing contact; it never creates a second copy.
* **Deleting a group only removes `LeadGroup` rows.** Contacts survive in
  "All Contacts". `Campaign` rows are kept and their `recipientGroupId` is set
  to `NULL` by `ON DELETE SET NULL` — campaign history is never destroyed.
* **Campaigns store a group id, never a group name.** Renaming a group cannot
  rewrite who a campaign was addressed to.
* **The recipient list is snapshotted at launch.** On `start`,
  `src/app/api/campaigns/[id]/status/route.ts` resolves the group's *current*
  members and materialises them into `CampaignRecipient` in one transaction.
  The worker only ever reads those rows, so adding someone to the group
  afterwards cannot add them to a running campaign, and removing someone
  cannot corrupt history. Already-sent prospects are not re-queued.
* **No group selected = every lead.** `groupLeadWhere(userId, null)` in
  `src/lib/groups.ts` deliberately returns the pre-Groups behaviour so
  existing campaigns keep working unchanged.
* Existing leads had no group and were left ungrouped. Nothing was invented
  for them.

Routes added: `GET|POST /api/groups`, `GET|PATCH|DELETE /api/groups/[id]`,
`GET|POST|DELETE /api/groups/[id]/leads`, plus `?group=<id>` support on
`/api/leads/export`. All follow the existing `assertSameOrigin` + `getSession`
convention.

Verification harnesses (they write to the live DB — read the warning header in
each file first):

```powershell
$env:BASE_URL="https://<tunnel-url>"
node tests\e2e\groups-flow.mjs    # 43 checks: import -> group -> campaign -> delete
node tests\e2e\pages-render.mjs   # 14 checks: every touched page renders
npx vitest run                    # 205 unit tests, incl. tests/groups.test.ts
```

## 10. Multiple Gmail accounts (added 2026-09-28)

**There is no `GmailAccount` table, and there should not be one.** The existing
`GoogleAccount` model was already the multi-account model this feature needs:

| Spec asked for            | Already in `GoogleAccount`            |
|---------------------------|---------------------------------------|
| `id`, `userId`            | `id`, `userId`                        |
| `email`                   | `googleEmail` (globally `@unique`)    |
| encrypted access/refresh  | `accessTokenEncrypted` / `refreshTokenEncrypted` (AES-256-GCM) |
| `tokenExpiry`             | `expiresAt`                           |
| `status`                  | `status` + `statusMessage` (added)    |
| `Campaign.gmailAccountId` | `Campaign.googleAccountId`            |

Creating a second table would have meant copying encrypted token blobs out of
the working row, which is exactly what "do not delete the existing OAuth tokens"
forbids. Migration `20260928030000_add_google_account_status` only adds two
columns and one index — no token was touched.

Already correct before this work, and deliberately left alone: the worker resolves
`campaign.googleAccount` per campaign and never uses a global token; disconnect is
per-account; the OAuth callback matches on `(userId, googleEmail)` so it creates a
new row for a new mailbox and refreshes the existing one otherwise; the From
address is the account's own email and the message is sent with `userId: "me"`,
so a campaign cannot spoof a different sender.

### The two bugs that would have broken the working account

Both are fixed by `mergeStoredTokens()` in `src/lib/google.ts`, and both are now
covered by `tests/gmail-multi-account.test.ts`.

1. **The worker wiped the refresh token on every send that crossed an expiry.**
   `getAuthorizedOAuthClient` returns `encryptTokens(credentials)` from Google's
   token endpoint — and that response contains **no `refresh_token`**, so writing
   it straight to the row set `refreshTokenEncrypted` to `NULL`. Once that
   happens the account can never refresh again and is dead permanently.
   Verified empirically, not assumed:
   `node scripts\verify-gmail-live.mjs` prints
   `google returned a new refresh token: no`.
2. **Re-authorizing could do the same.** Google omits `refresh_token` when
   re-consenting for an already-approved app, so the callback's update would have
   destroyed the refresh token of the very account being reconnected.

A refresh token is now only ever overwritten when Google actually issues a new one.

### Other changes

* `buildAuthUrl` sends `prompt: "consent select_account"`. `consent` keeps Google
  issuing the offline refresh token; `select_account` forces the account chooser
  so "+ Add Gmail Account" cannot silently re-authorize whichever mailbox is
  already signed in. Verified against the live redirect — see below.
* Per-account health in `deriveAccountStatus()`: `connected` / `token_expired` /
  `reauth_required`. `reauth_required` is sticky and only cleared by a successful
  authorization. The worker sets it on `invalid_grant`, which fails the
  recipient and pauses the campaign without crashing. Only the *offending*
  account is flagged, so one revoked grant cannot affect the others.
* Settings now says "Gmail Accounts" / "+ Add Gmail Account" and shows a status
  badge plus a **Reconnect** button on any account that is not healthy.
* The campaign sender dropdown is preselected when exactly one account is
  connected; with two or more the operator must choose deliberately.
* Campaign detail shows "Sending account: <email> (Gmail)" and a recipient count.
* The callback's legacy "bind senderless campaigns" repair now runs **only** on
  the user's *first* Gmail connect, so adding a second account cannot claim
  campaigns that were not its own.

### Verifying a Gmail account is genuinely alive

A non-null refresh token does not prove the grant works. This decrypts the stored
token, exchanges it, and calls a Gmail endpoint the granted scopes cover, then
prints identity checks. It prints no token material and changes nothing:

```powershell
node scripts\verify-gmail-live.mjs   # refresh grant, settings.sendAs, identity match
node scripts\gmail-snap.mjs          # per-account row + token fingerprints (never the token)
```

A `403` from `users.getProfile` is **expected and not a fault** — that endpoint
needs a read scope this app deliberately does not request (only `gmail.send`).
Use `settings.sendAs` to prove the grant instead.

### Adding a second account by hand

The automated tests cover everything except Google's own consent screen, which
needs a human:

1. Settings → **+ Add Gmail Account**. The Google account chooser appears — pick
   the *second* mailbox.
2. Both accounts should now be listed, each with its own Disconnect/Reconnect.
3. Create a campaign and pick the second account as **Sending Gmail account**.
4. Send to an address you control and confirm it arrives *from* the second
   mailbox.
5. Disconnect the second account and confirm the first is still connected.

Scopes are unchanged and must stay that way: `gmail.send` (sensitive) and
`gmail.settings.basic` (restricted) plus `openid` and `email` for identity.
Do not add a broader Gmail scope.

### Production state as of 2026-09-29

Two Gmail accounts are connected and both grants were verified live
(`node scripts\verify-gmail-live.mjs`): the original `sammalik7450@gmail.com`
and a second `alarichealthservices@gmail.com`. A campaign ("AHS test", group
"test 1", 680 recipients) sent 100 messages from the second account before
pausing at the daily cap, with 0 failures and 0 skips. So account selection,
per-account sending and the original account's survival are all confirmed
working in production. Actual inbox delivery was not verified from here — that
needs a human check on the receiving side.

Note the worker is a **single instance** (`ecosystem.config.cjs` says so). Its
per-minute rate limit is an in-process token bucket, so a second worker would
double the effective send rate against Gmail's quota. Always check
`pm2 list` before running `npm run worker` by hand.

## 11. Per-campaign sender name (added 2026-09-30)

Every campaign can now set its own sender **display name** ("Leo's Outreach")
without touching the global `SENDER_NAME` env value or the Gmail account name.

- `Campaign.senderName` is `TEXT NULL`. `NULL` means "fall back to
  `SENDER_NAME`", so all pre-existing campaigns keep their old behaviour and
  nothing was rewritten. Migration
  `20260930102000_add_campaign_sender_name` is a single `ADD COLUMN`.
- Resolution happens in one place, `worker.ts`: `campaign.senderName?.trim() || env.SENDER_NAME`.
- The From **address** always comes from the campaign's selected sending account.
  This field is a display name only, so it can never spoof a different sender.
- The new-campaign form is pre-filled with the current `SENDER_NAME` so the
  operator edits a real value instead of guessing. Clearing it means "use the
  default", which is a deliberate opt-out rather than an empty sender.

### Header-injection hardening (do not undo)

`encodeHeaderValue` in `src/lib/message.ts` previously returned any **ASCII**
value verbatim, because it only RFC 2047-encoded when it saw a non-ASCII byte. A
display name or subject containing `\r\n` was therefore emitted as a real extra
header — a sender name could smuggle in a `Bcc:` line and mail every recipient a
copy. That path is now closed in two independent layers:

1. `campaignCreateSchema` **rejects** CR/LF and `<>` in `senderName`
   (400 before anything is written).
2. `encodeHeaderValue` **collapses** CR/LF to a single space unconditionally,
   which also closes the same latent hole in template subjects.

Layer 2 is the one that matters for safety — layer 1 can be bypassed by any
future caller. Both are covered by `tests/campaign-sender-name.test.ts` (19
cases). If you rewrite that function, keep the CR/LF collapse and re-run the
injection cases.

### Verifying it

```
node scripts\verify-sender-name.mjs
```

Read-only. Checks the form renders pre-filled, the detail page and preview API
resolve the name, and that the create API rejects CRLF, bare CR/LF, `<>`
forgery, over-length and blank values. It intentionally does **not** perform a
successful create, because this app has no `DELETE /api/campaigns` route and a
probe row could not be cleaned up.

### Unverified: does Gmail keep the custom name?

Not proven. Gmail's `settings.sendAs` has its own display name and Gmail may
rewrite the `From` display name to match it. The RFC-2822 we build is correct
and `From: <name> <address>` is what reaches Gmail's API, but whether the
custom name survives to the recipient's inbox needs a real send checked by a
human on the receiving side. If Gmail overrides it, the fix is to set the
matching name in Gmail's own send-as settings.
