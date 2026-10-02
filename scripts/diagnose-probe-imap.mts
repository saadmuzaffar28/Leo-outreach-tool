/**
 * Bisect: why does `probeImap` fail when a direct login succeeds?
 *
 * Reproduces `buildClient`'s exact option set and peels it back one field at a
 * time. Read-only: connect + logout only.
 *
 * Run: npx tsx scripts/diagnose-probe-imap.mts
 */

import "dotenv/config";
import { ImapFlow } from "imapflow";
import { prisma } from "../src/lib/prisma.ts";
import { decrypt } from "../src/lib/encryption.ts";

async function attempt(label, opts) {
  const client = new ImapFlow({ logger: false, socketTimeout: 30_000, connectionTimeout: 30_000, greetingTimeout: 30_000, ...opts });
  try {
    await client.connect();
    console.log(`  OK    ${label}`);
    return { ok: true };
  } catch (err) {
    const e = err ?? {};
    console.log(`  FAIL  ${label}`);
    console.log(`          ${e.responseStatus ?? ""} ${e.responseText ?? ""} ${e.message ?? String(e)}`.replace(/\s+/g, " ").trim().slice(0, 200));
    return { ok: false, err };
  } finally {
    try { await client.logout(); } catch { try { await client.close(); } catch { /* nothing to close */ } }
  }
}

async function main() {
  const row = await prisma.smtpAccount.findFirst({ orderBy: { email: "asc" } });
  const user = decrypt(row.usernameEncrypted);
  const pass = decrypt(row.passwordEncrypted);
  console.log(`\ntesting mailbox: ${row.email}\n`);

  console.log("A. exactly what buildClient() constructs today (NOTE: no `auth`):");
  await attempt("buildClient as-written", {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    requireTLS: undefined,
    tls: { rejectUnauthorized: true },
  });

  console.log("\nB. same, but with credentials:");
  await attempt("buildClient + auth", {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    tls: { rejectUnauthorized: true },
    auth: { user, pass },
  });

  console.log("\nC. auth only, nothing else unusual:");
  await attempt("host/port/secure/auth", {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
  });

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});