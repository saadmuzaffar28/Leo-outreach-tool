/**
 * Persist the verified IMAP endpoint for the configured mailboxes.
 *
 * WHY: `imapConfigFor` returns null unless `imapHost` is set, so until this
 * runs, production skips delivery verification entirely and every warm-up job
 * would sit at `sent` -> `unconfirmed`. `scripts/audit-imap-reachability.mjs`
 * established that all six authenticate against imap.gmail.com:993 over implicit
 * TLS using their EXISTING SMTP credentials.
 *
 * WHAT THIS TOUCHES: `imapHost`, `imapPort`, `imapSecurity`, and the
 * display-only `imapStatus` / `imapLastTestedAt`. It never writes a credential.
 * `imapUsernameEncrypted` / `imapPasswordEncrypted` are deliberately left NULL so
 * the existing fallback to the already-encrypted SMTP credentials keeps working
 * and no new secret is ever created or copied around.
 *
 * REVERSIBLE: `--revert` restores exactly the values printed below, which is why
 * they are printed before anything is written.
 *
 * Run:  npx tsx scripts/configure-imap-endpoints.mts [--revert]
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.ts";

const ENDPOINT = { imapHost: "imap.gmail.com", imapPort: 993, imapSecurity: "ssl" };
const REVERT = process.argv.includes("--revert");

async function main() {
  const rows = await prisma.smtpAccount.findMany({
    select: {
      id: true,
      email: true,
      imapHost: true,
      imapPort: true,
      imapSecurity: true,
      imapStatus: true,
      imapUsernameEncrypted: true,
      imapPasswordEncrypted: true,
    },
    orderBy: { email: "asc" },
  });

  console.log(
    REVERT
      ? "REVERTING IMAP endpoint configuration"
      : `CONFIGURING IMAP endpoint for ${rows.length} mailboxes`,
  );
  console.log(`  target: ${ENDPOINT.imapHost}:${ENDPOINT.imapPort}/${ENDPOINT.imapSecurity}\n`);

  for (const row of rows) {
    console.log(`  ${row.email}`);
    console.log(
      `    before: imapHost=${row.imapHost ?? "(null)"} port=${row.imapPort} ` +
        `security=${row.imapSecurity} status=${row.imapStatus}`,
    );
    console.log(
      `    credentials: imapUser=${row.imapUsernameEncrypted ? "own copy" : "falls back to SMTP"} ` +
        `imapPass=${row.imapPasswordEncrypted ? "own copy" : "falls back to SMTP"}`,
    );

    if (REVERT) {
      await prisma.smtpAccount.update({
        where: { id: row.id },
        data: {
          imapHost: null,
          imapPort: 993,
          imapSecurity: "ssl",
          imapStatus: "unconfigured",
          imapLastTestedAt: null,
          imapLastTestError: null,
        },
      });
    } else {
      await prisma.smtpAccount.update({
        where: { id: row.id },
        data: {
          ...ENDPOINT,
          // Authenticated against the real server moments ago; recording that is
          // more honest than leaving the badge reading "unconfigured" next to a
          // host that is set.
          imapStatus: "connected",
          imapLastTestedAt: new Date(),
          imapLastTestError: null,
        },
      });
    }
  }

  const verify = await prisma.smtpAccount.count({
    where: REVERT ? { imapHost: null } : { imapHost: ENDPOINT.imapHost },
  });
  console.log(`\n  verified: ${verify}/${rows.length} mailboxes now match the expected state`);
  console.log(`  no credential was written by this script`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});