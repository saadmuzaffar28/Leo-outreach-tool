/**
 * Read-only warm-up state audit against the production database.
 *
 * Used to confirm the deployed warm-up is INERT: nothing enrolled, nothing
 * enabled, no jobs, no sends. Run this before and after the Phase 2 live test
 * so the difference is evidence rather than assumption.
 *
 * Run: node scripts/audit-warmup-state.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      email: true,
      sendSettings: {
        select: {
          dailySendLimit: true,
          warmupEnabled: true,
          warmupStartingDailyVolume: true,
          warmupDailyIncrease: true,
          warmupMaximumDailyVolume: true,
          warmupMinDelaySeconds: true,
          warmupMaxDelaySeconds: true,
        },
      },
    },
  });

  const enrolled = await prisma.warmupMailboxSettings.findMany({
    select: {
      enabled: true,
      status: true,
      startingDailyVolume: true,
      maximumDailyVolume: true,
      dailyIncrease: true,
      minimumDelaySeconds: true,
      maximumDelaySeconds: true,
      warmupWindowStart: true,
      warmupWindowEnd: true,
      consecutiveFailures: true,
      smtpAccount: { select: { email: true } },
    },
    orderBy: { smtpAccount: { email: "asc" } },
  });

  const jobs = await prisma.warmupJob.count();
  const events = await prisma.warmupEvent.count();
  const usage = await prisma.warmupDailyUsage.aggregate({
    _sum: { warmupSent: true, delivered: true, warmupFailed: true },
  });
  const enabledCount = enrolled.filter((m) => m.enabled).length;

  console.log("=== GLOBAL WARM-UP SETTINGS ===");
  for (const u of users) {
    const s = u.sendSettings;
    console.log(
      `  ${u.email}\n` +
        `    dailySendLimit            ${s ? s.dailySendLimit : "(none)"}`,
    );
    console.log(
      `    warmupEnabled             ${s ? s.warmupEnabled : "(none)"}   <-- global master switch`,
    );
    if (s) {
      console.log(`    warm-up ramp defaults     start=${s.warmupStartingDailyVolume} +${s.warmupDailyIncrease}/day max=${s.warmupMaximumDailyVolume}`);
      console.log(`    warm-up delays            ${s.warmupMinDelaySeconds}s..${s.warmupMaxDelaySeconds}s`);
    }
  }

  console.log(`\n=== ENROLLED MAILBOXES (${enrolled.length}) ===`);
  if (enrolled.length === 0) console.log("  none -- no mailbox is enrolled in warm-up");
  for (const m of enrolled) {
    console.log(
      `  ${m.smtpAccount.email}\n` +
        `    enabled=${m.enabled} status=${m.status} failures=${m.consecutiveFailures}\n` +
        `    ramp start=${m.startingDailyVolume} +${m.dailyIncrease}/day max=${m.maximumDailyVolume}\n` +
        `    delay ${m.minimumDelaySeconds}s..${m.maximumDelaySeconds}s  window ${m.warmupWindowStart}-${m.warmupWindowEnd}`,
    );
  }

  console.log(`\n=== ACTIVITY ===`);
  console.log(`  warmupJob rows        ${jobs}`);
  console.log(`  warmupEvent rows      ${events}`);
  console.log(
    `  warmupDailyUsage      sent=${usage._sum.warmupSent ?? 0} delivered=${usage._sum.delivered ?? 0} failed=${usage._sum.warmupFailed ?? 0}`,
  );

  console.log(`\n=== VERDICT ===`);
  console.log(`  mailboxes with warm-up ENABLED: ${enabledCount}`);
  if (enabledCount === 0 && jobs === 0) {
    console.log("  INERT -- the worker is polling but has nothing it is allowed to do.");
  } else {
    console.log("  ACTIVE -- warm-up is enrolled and/or has run.");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});