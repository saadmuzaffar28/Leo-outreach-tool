# Leo Outreach — email verification service (AfterShip)

A small, isolated Go HTTP service that wraps the open-source
[`AfterShip/email-verifier`](https://github.com/AfterShip/email-verifier)
(MIT) library as its verification engine. Leo Outreach (TypeScript/Next.js)
talks to it over loopback JSON; the Node-side adapter
(`src/lib/verification/aftership-adapter.ts`) is the only code that knows its
payload shapes.

This service is consumed as a **Go module dependency** — no library source
code was copied into this repository. See `LICENSE-AFTERSHIP.txt` (the
verbatim MIT license of AfterShip/email-verifier) and `THIRD_PARTY_NOTICES.md`
at the repo root.

## Build

Requires a Go toolchain ≥ 1.25 (the `go.mod` toolchain of the dependency).

```
npm run verifier:build      # → dist/verifier/email-verifier(.exe)
```

## Run

```
npm run verifier:start
```

It is registered in `ecosystem.config.cjs` as `leo-verifier` (PM2).

## Endpoints

- `GET /healthz` — liveness + engine info
- `POST /v1/verify` — `{ "email": "a@b.c" }` → neutral facts payload:
  `email, reachable, syntax{username,domain,valid}, has_mx_records,
  disposable, role_account, free, suggestion, smtp{host_exists,full_inbox,
  catch_all,deliverable,disabled}, error{message,details,kind}`

Status classification (VALID / INVALID / CATCH_ALL / RISKY / UNKNOWN) happens
**only** in the Node adapter, not here.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMAIL_VERIFICATION_LISTEN` | `127.0.0.1:8099` | Bind address. Keep loopback. |
| `EMAIL_VERIFICATION_SERVICE_TOKEN` | *(empty)* | If set, `Authorization: Bearer <token>` is required. |
| `EMAIL_VERIFICATION_SMTP_ENABLED` | `true` | Enable SMTP mailbox/catch-all checks. |
| `EMAIL_VERIFICATION_FROM_EMAIL` | `user@example.org` | Address used in `MAIL FROM` during checks. **Set this to a domain you control (with PTR)** — servers validating the sender may reject `example.org`. |
| `EMAIL_VERIFICATION_HELLO_NAME` | `localhost` | EHLO hostname. |
| `EMAIL_VERIFICATION_TIMEOUT_MS` | `15000` | Per-request/DNS/SMTP operation timeout. |
| `EMAIL_VERIFICATION_MAX_INFLIGHT` | `4` | Global cap of simultaneous verifications. |

The Node app expects the service at `EMAIL_VERIFICATION_SERVICE_URL`
(default `http://127.0.0.1:8099`) and mirrors `EMAIL_VERIFICATION_TIMEOUT_MS`.

## SMTP reality check

- SMTP verification is **never guaranteed**; many providers (Gmail, Microsoft
  365, Yahoo) greylist, rate-limit or refuse real-time checks. The adapter
  maps all ambiguous answers to `UNKNOWN`, never `INVALID`.
- Outbound port 25 is often blocked by ISPs/hosters; SMTP checks then time
  out and results degrade to `UNKNOWN` (DNS checks still run).
- No actual marketing email is ever sent by this service — it only performs
  SMTP handshake/RCPT probes.
