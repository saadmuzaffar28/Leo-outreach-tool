/**
 * Read-only IMAP reachability check for the configured mailboxes.
 *
 * Replaces the ad-hoc `scripts/probe-imap.ts` that Phase 5 removed: this calls
 * the SHIPPED `imapConfigFor` + `probeImap`, so the answer describes the code
 * that will actually run in the worker, not a parallel implementation.
 *
 * Strictly read-only: connect, authenticate, disconnect. No folder listing, no
 * message fetch, nothing flagged as seen. Credentials are decrypted in memory
 * and never printed -- only whether the login worked and how long it took.
 *
 * Run: node scripts/audit-imap-reachability.mjs
 */

import "dotenv/config";
import { ImapFlow } from "imapflow";
import { prisma as appPrisma } from "../src/lib/prisma.ts";
import { decrypt } from "../src/lib/encryption.ts";
import { imapConfigFor, probeImap } from "../src/lib/warmup/imap.ts";

/**
 * `--raw` shows the server's own words.
 *
 * `probeImap` deliberately hides them: an IMAP server can echo the login back,
 * and that text reaches an HTTP response and the database. That is right for
 * production and useless for diagnosis, which is exactly why the original error
 * is preserved on the error's `cause`. This is the sanctioned, server-side place
 * to look at it. It never leaves this script and is never persisted.
 */
const RAW = process.argv.includes("--raw");

/** Log in once and hand back whatever the server actually said. */
async function rawLogin(host, port, secure, username, password) {
  const client = new ImapFlow({
    host,
    port,
    secure,
    logger: false,
    socketTimeout: 30_000,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    auth: { user: username, pass: password },
  });
  try {
    await client.connect();
    return "authenticated";
  } catch (err) {
    const e = err ?? {};
    return `${e.responseStatus ?? ""} ${e.responseText ?? ""} ${e.message ?? String(e)}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        await client.close();
      } catch {
        /* nothing left to close */
      }
    }
  }
}

async function main() {
  const rows = await appPrisma.smtpAccount.findMany({
    select: {
      id: true,
      email: true,
      host: true,
      port: true,
      security: true,
      imapHost: true,
      imapPort: true,
      imapSecurity: true,
      imapUsernameEncrypted: true,
      imapPasswordEncrypted: true,
      usernameEncrypted: true,
      passwordEncrypted: true,
      imapStatus: true,
    },
    orderBy: { email: "asc" },
  });

  console.log(`IMAP REACHABILITY (read-only: login + logout only)\n`);
  console.log(`mailboxes: ${rows.length}\n`);

  // A mailbox with no IMAP host configured cannot be probed directly. Rather
  // than write an imapHost into production merely to find out, try the obvious
  // candidate in memory: these are all Gmail SMTP accounts, so imap.gmail.com
  // over implicit TLS, authenticated with the SMTP credentials that
  // `imapConfigFor` already knows how to fall back to.
  //
  // NOTHING IS PERSISTED. This answers "can IMAP confirmation work at all?"
  // before anyone configures anything. If these addresses are Gmail send-as
  // aliases, the SMTP login works for sending but IMAP rejects it -- which is
  // exactly the condition the operator needs to be told about.
  const CANDIDATE = { imapHost: "imap.gmail.com", imapPort: 993, imapSecurity: "ssl" };

  let ok = 0;
  for (const row of rows) {
    const configured = imapConfigFor(row);
    const cfg = configured ?? imapConfigFor({ ...row, ...CANDIDATE });
    if (!cfg) {
      console.log(`  SKIP  ${row.email}  -- could not build any IMAP config`);
      continue;
    }
    const started = Date.now();
    const result = await probeImap(cfg);
    const ms = Date.now() - started;
    if (result.ok) ok++;
    console.log(
      `  ${result.ok ? "OK  " : "FAIL"}  ${row.email}  ` +
        `(${cfg.host}:${cfg.port}/${cfg.security}, ${ms}ms)` +
        `${configured ? "" : "   [candidate, NOT saved]"}`,
    );
    if (!result.ok) {
      console.log(`          reason: ${result.message}`);
      if (RAW) {
        const detail = await rawLogin(
          cfg.host,
          cfg.port,
          cfg.security === "ssl",
          decrypt(row.imapUsernameEncrypted ?? row.usernameEncrypted),
          decrypt(row.imapPasswordEncrypted ?? row.passwordEncrypted),
        );
        console.log(`          raw:    ${detail}`);
      }
    }
  }

  console.log(`\nresult: ${ok}/${rows.length} mailboxes can authenticate over IMAP`);
  if (ok === 0) {
    console.log(
      "\nDelivery CONFIRMATION is therefore impossible right now. SMTP send\n" +
        "will still work; jobs will land in 'sent' and then 'unconfirmed'.",
    );
  } else if (ok < rows.length) {
    console.log(
      "\nOnly the OK mailboxes can be used as warm-up RECEIVERS, since a message\n" +
        "must be confirmed in the receiving mailbox's own inbox.",
    );
  }

  await appPrisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await appPrisma.$disconnect();
  process.exit(1);
});