/**
 * Reset warm-up to the inert state after a live test.
 *
 * Removes only warm-up bookkeeping for the given mailboxes: settings rows,
 * jobs, events, and daily usage. These are test artifacts.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: `DailySendCounter`. Those sends really
 * happened -- they are sitting in real inboxes and they really did draw on the
 * budget shared with campaigns. Zeroing the counter would erase that history and
 * hand back 4 extra sends today for no reason. The counter is printed so the
 * real consumption stays visible.
 *
 * `warmupEnabled` is restored to false, its shipped default.
 *
 * Run: npx tsx scripts/reset-warmup-live-test.mts [email ...]
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.ts";

const EMAILS = process.argv.slice(2);
const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  const targets = EMAILS.length
    ? await prisma.smtpAccount.findMany({ where: { email: { in: EMAILS } }, select: { id: true, email: true } })
    : await prisma.smtpAccount.findMany({
        where: { warmupSettings: { isNot: null } },
        select: { id: true, email: true },
      });

  console.log("=== RESETTING WARM-UP TO INERT ===\n");
  console.log(`  mailboxes with warm-up settings: ${targets.length}`);

  const settingsRows = await prisma.warmupMailboxSettings.findMany({
    where: { smtpAccountId: { in: targets.map((t) => t.id) } },
    select: { id: true },
  });
  const ids = settingsRows.map((s) => s.id);

  // Pause first so a live worker cannot schedule anything mid-teardown.
  await prisma.warmupMailboxSettings.updateMany({
    where: { id: { in: ids } },
    data: { enabled: false, status: "paused" },
  });
  console.log("  paused every enrolled mailbox (prevents rescheduling during teardown)");

  const jobs = await prisma.warmupJob.deleteMany({ where: { mailboxId: { in: ids } } });
  const events = await prisma.warmupEvent.deleteMany({ where: { mailboxId: { in: ids } } });
  const usage = await prisma.warmupDailyUsage.deleteMany({ where: { mailboxId: { in: ids } } });
  const settings = await prisma.warmupMailboxSettings.deleteMany({ where: { id: { in: ids } } });

  console.log(`  deleted ${jobs.count} jobs, ${events.count} events, ${usage.count} usage rows, ${settings.count} settings rows`);

  const owners = await prisma.user.findMany({ where: { smtpAccounts: { some: { id: { in: targets.map((t) => t.id) } } } } });
  for (const u of owners) {
    await prisma.sendSettings.updateMany({ where: { userId: u.id }, data: { warmupEnabled: false } });
  }
  console.log(`  restored warmupEnabled=false for ${owners.length} user(s)`);

  const remaining = await prisma.warmupMailboxSettings.count();
  console.log(`\n  mailboxes still enrolled: ${remaining}`);

  console.log(`\n--- DailySendCounter for ${TODAY} (REAL consumption, left untouched) ---`);
  // DailySendCounter carries no relation to the mailbox, only a bare accountId
  // (the same row shape serves sms and smtp), so the emails are resolved by hand.
  const counters = await prisma.dailySendCounter.findMany({ where: { date: TODAY } });
  if (!counters.length) console.log("  (none)");
  const accounts = await prisma.smtpAccount.findMany({
    where: { id: { in: counters.map((c) => c.accountId) } },
    select: { id: true, email: true },
  });
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));
  for (const c of counters) {
    console.log(
      `  ${c.provider}/${emailById.get(c.accountId) ?? c.accountId}  ` +
        `sent=${c.messagesSent} failed=${c.messagesFailed} skipped=${c.messagesSkipped}`,
    );
  }
  const smtpTotal = counters.filter((c) => c.provider === "smtp").reduce((n, c) => n + c.messagesSent, 0);
  console.log(`\n  total SMTP sends charged today: ${smtpTotal}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});