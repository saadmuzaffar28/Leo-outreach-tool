# SMTP Feature — Honest Handoff (star-billing-outreach-main)

## COMPLETED + byte-verified on disk (numbered-read oracles confirmed ALL)
1. **Prisma schema** — `model SmtpAccount` with fields `id, userId, email, host, port, security (SmtpSecurity), usernameEncrypted, passwordEncrypted, status (SmtpConnectionStatus @default("untested")), lastTestedAt, lastTestError, createdAt, updatedAt` + `@@index([userId])`; `User.smtpAccounts` back-relation; `Campaign.smtpAccountId String?` + `smtpAccount SmtpAccount? @relation(...)`.
2. **`prisma db push` exit 0** (already in sync) and **`prisma generate` exit 0** → `prisma.smtpAccount` **exists** in Prisma Client (this was the stale-client fix).
3. **`package.json`** — `nodemailer@10.0.10` + `@types/nodemailer@8.0.1` present in deps.
4. **`src/lib/smtp.ts`** (177 lines) — REAL, with these confirmed exports:
   - `SmtpError` (class), `SmtpSecurity`, `SmtpConnectionStatus`, `SmtpAccountInput`, `SmtpAccountEncrypted`, `DecryptedSmtpAccount`
   - `encryptSmtpCredentials(input)` → encrypted struct
   - `decryptSmtpCredentials(enc)` 
   - `classifySmtpError(err)` → `SmtpError`
   - `buildTransporter(...)`
   - `testSmtpConnection(account)` → **`Promise<void>` — THROWS typed `SmtpError` on failure. Does NOT return `{ok,...}`.**
   - `sendSmtpMail(...)`
   - `SmtpAccountView` — **an interface/type, NOT a `toSmtpAccountView` function**
5. **`src/lib/http.ts`** (46 lines) — REAL exports: `jsonResponse, unauthorized, forbidden, notFound, badRequest, serverError, isJsonRequest, assertSameOrigin`.

## NOT DONE — the gates are RED right now (do not claim otherwise)
The 3 SMTP API route files exist but **do not compile** against the real lib. Confirmed errors:
- `accounts/route.ts` — imports `toSmtpAccountView` (no such export; it's the `SmtpAccountView` interface), and calls `testSmtpConnection(...)` expecting `{ok, error}` — real signature returns `void` and throws.
- `[id]/route.ts` — same `toSmtpAccountView` import issue + `encryptSmtpCredentials` name/import mismatch (tsc suggests `decryptSmtpCredentials`).
- `test/route.ts` — imports `encryptedJson` (http.ts has no such export; use `jsonResponse`) and `badRequest`/`forbidden` mismatch.

Also **NOT written / unverified**: Settings page SMTP card UI, campaign "Sending account" dropdown + selector persistence, worker SMTP dispatch branch, `tests/smtp.test.ts`, and the green gates themselves (`tsc --noEmit`, `npm test`, `npm run build`).

## EXACT REMAINING STEPS (in order)
1. **Rewrite the 3 route files** against the real surface:
   - Never import `toSmtpAccountView` — build the view INLINE as an object matching `SmtpAccountView` fields (id,email,host,port,security,status,lastTestedAt,lastTestError,createdAt). NEVER include username/password/encrypted fields in the view.
   - Wrap `testSmtpConnection` in try/catch; on throw use `e instanceof SmtpError ? e : classifySmtpError(e)` and return `{error: e.userMessage, code: e.code}` with 400.
   - Import response helpers from `@/lib/http`: `jsonResponse, forbidden, badRequest, notFound`.
   - On PATCH, only re-encrypt when a NEW password is supplied; otherwise keep existing ciphertext.
2. **Settings page SMTP card** (email/host/port/security/username/password, live Test Connection, connected/error state, Edit, Disconnect). Password never pre-filled, never returned.
3. **Campaign form** — "Sending account / From" dropdown listing `SmtpAccountView` accounts + persist `smtpAccountId` on campaign.
4. **Worker** — SMTP provider branch: load `smtpAccountId`, `prisma.smtpAccount.findUnique`, `decryptSmtpCredentials`, `buildTransporter`, `sendSmtpMail`. Never log password/decrypted creds; reuse existing retry/error handling and send failure recording.
5. **Tests** — `tests/smtp.test.ts` covering 15 cases (encryption round-trip, no password leak in view, classify auth/TLS/refused/host/config errors, transporter build, void-return contract, send-mock via mocked transporter).
6. **Gates until GREEN (only then report completion):**
   ```
   npx tsc --noEmit
   npm test
   npm run build
   ```
   Fix whatever each reports, recursively. Do not stop while tsc/tests/build are red. Restart the app + worker after gates pass.

## Status
`Gates: tsc RED, vitest not-final-green, build not-run-green`. Feature is part-built and honest: **not complete**.
