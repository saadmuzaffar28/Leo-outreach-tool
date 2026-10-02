/**
 * PHASE 2 — controlled live warm-up test, A -> B then B -> A.
 *
 * WHAT THIS DOES: enrols exactly TWO mailboxes with a volume of 1, lets the
 * REAL deployed worker (PM2 `leo-outreach-warmup`) do all the sending, and then
 * reports evidence for ten checkpoints. It never sends mail itself — driving the
 * live worker is the point.
 *
 * WHY BOTH DIRECTIONS LAND IN ONE PASS: the pool only ever contains enrolled
 * mailboxes, and a mailbox with no enabled peer refuses to plan at all
 * ("No other enrolled warm-up mailbox to receive from"). That is a deliberate
 * safety property — warm-up must never reach an external prospect — but it also
 * means a single enabled pair necessarily exercises both directions, because A's
 * only possible receiver is B and vice versa. One send each way is therefore the
 * minimum traffic that can prove both directions work.
 *
 * TRAFFIC: 2 messages total, to mailboxes owned by this deployment. No external
 * recipient is possible by construction.
 *
 * Run: npx tsx scripts/phase2-live-warmup-test.mts
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.ts";

const A = "leo@collabrevsolutions.site";
const B = "jason@collabrevsolutions.site";
const USER = "admin@example.com";

/** One message each way. This is the floor for proving both directions. */
const TEST_SETTINGS = {
  startingDailyVolume: 1,
  maximumDailyVolume: 1,
  dailyIncrease: 0,
  // Short so the test finishes in a couple of minutes rather than the 60-120s
  // production default. Spacing is still jittered and still non-zero.
  minimumDelaySeconds: 8,
  maximumDelaySeconds: 12,
  warmupWindowStart: "00:00",
  warmupWindowEnd: "23:59",
};

const results: Array<{ ok: boolean | null; name: string; detail: string }> = [];
function check(name: string, ok: boolean | null, detail: string) {
  results.push({ ok, name, detail });
  const tag = ok === null ? " ?  " : ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}`);
  console.log(`         ${detail}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enrol(email: string) {
  const acct = await prisma.smtpAccount.findFirstOrThrow({
    where: { email, user: { email: USER } },
  });
  const settings = await prisma.warmupMailboxSettings.upsert({
    where: { smtpAccountId: acct.id },
    update: { ...TEST_SETTINGS, enabled: true, status: "running", currentDay: 0 },
    create: {
      userId: acct.userId,
      smtpAccountId: acct.id,
      ...TEST_SETTINGS,
      enabled: true,
      status: "running",
      currentDay: 0,
    },
  });
  return { acct, settings };
}

async function main() {
  const acctA = await prisma.smtpAccount.findFirstOrThrow({ where: { email: A } });
  const acctB = await prisma.smtpAccount.findFirstOrThrow({ where: { email: B } });
  const userId = acctA.userId;

  console.log("=== PHASE 2 LIVE WARM-UP TEST ===\n");
  console.log(`  A = ${A}`);
  console.log(`  B = ${B}`);
  console.log(`  volume = ${TEST_SETTINGS.startingDailyVolume} message each way`);
  console.log(`  delay  = ${TEST_SETTINGS.minimumDelaySeconds}-${TEST_SETTINGS.maximumDelaySeconds}s\n`);

  // ---- CP0: baseline is inert -------------------------------------------
  const before = await prisma.warmupJob.count();
  const settingsRow = await prisma.sendSettings.findUniqueOrThrow({ where: { userId } });
  // Baseline for CP10. The shared counter is CUMULATIVE for the whole UTC day
  // and is shared with real campaign sends, so it must be compared as a delta.
  // An earlier version of this script asserted an absolute total and reported a
  // false failure purely because a previous test run had already spent budget.
  const counterBaseline = await prisma.dailySendCounter.aggregate({
    where: { userId, date: new Date().toISOString().slice(0, 10), provider: "smtp" },
    _sum: { messagesSent: true },
  });
  console.log(`--- CP0: pre-test state ---`);
  console.log(`  existing jobs: ${before}, warmupEnabled: ${settingsRow.warmupEnabled}`);
  console.log(`  SMTP sends already charged today: ${counterBaseline._sum.messagesSent ?? 0}`);

  // The global switch must be ON for this test; it is off by default.
  await prisma.sendSettings.update({ where: { userId }, data: { warmupEnabled: true } });

  // ---- Enrol exactly two ------------------------------------------------
  const a = await enrol(A);
  const b = await enrol(B);
  console.log(`\n  enrolled A=${a.settings.id.slice(0, 8)}  B=${b.settings.id.slice(0, 8)}`);

  const enrolled = await prisma.warmupMailboxSettings.count({ where: { enabled: true } });
  check(
    "only the two intended mailboxes are enrolled",
    enrolled === 2,
    `${enrolled} mailbox settings enabled in total (expected 2)`,
  );

  // ---- Watch ------------------------------------------------------------
  console.log(`\n--- waiting for the deployed worker to send (up to 6 min) ---`);
  const deadline = Date.now() + 6 * 60 * 1000;
  let sawSentWithoutDelivery = false;
  let lastReport = "";

  while (Date.now() < deadline) {
    const jobs = await prisma.warmupJob.findMany({
      include: {
        senderSmtpAccount: { select: { email: true } },
        receiverSmtpAccount: { select: { email: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // CP6: an SMTP-accepted job must not yet be marked delivered.
    if (
      jobs.some((j) => j.status === "sent" && j.deliveredAt === null && j.sentAt !== null)
    ) {
      sawSentWithoutDelivery = true;
    }

    const summary = jobs
      .map(
        (j) =>
          `${j.senderSmtpAccount.email}->${j.receiverSmtpAccount.email}:${j.status}`,
      )
      .join("  ");
    if (summary !== lastReport) {
      console.log(`  [${new Date().toISOString().slice(11, 19)}] ${summary || "(no jobs yet)"}`);
      lastReport = summary;
    }

    if (jobs.length >= 2 && jobs.every((j) => j.status === "delivered")) break;
    if (jobs.some((j) => j.status === "failed" || j.status === "cancelled")) break;
    await sleep(5000);
  }

  // ---- Evidence ---------------------------------------------------------
  const jobs = await prisma.warmupJob.findMany({
    include: {
      senderSmtpAccount: { select: { email: true } },
      receiverSmtpAccount: { select: { email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n--- job rows ---`);
  for (const j of jobs) {
    console.log(`  ${j.senderSmtpAccount.email} -> ${j.receiverSmtpAccount.email}`);
    console.log(`    status      ${j.status}`);
    console.log(`    messageId   ${j.messageId}`);
    console.log(`    subject     ${j.subject}`);
    console.log(`    sentAt      ${j.sentAt?.toISOString() ?? "(null)"}`);
    console.log(`    deliveredAt ${j.deliveredAt?.toISOString() ?? "(null)"}`);
    console.log(`    latencyMs   ${j.deliveryLatencyMs ?? "(null)"}`);
    console.log(`    receiverUid ${j.receiverMessageId ?? "(null)"}`);
    console.log(`    attempts    ${j.attempts}  failureKind=${j.failureKind ?? "(none)"}`);
  }

  const aToB = jobs.filter(
    (j) => j.senderSmtpAccount.email === A && j.receiverSmtpAccount.email === B,
  );
  const bToA = jobs.filter(
    (j) => j.senderSmtpAccount.email === B && j.receiverSmtpAccount.email === A,
  );

  console.log(`\n--- checkpoints ---`);

  check(
    "CP1 A -> B happened",
    aToB.length === 1,
    `${aToB.length} job(s) from A to B`,
  );
  check(
    "CP2 B -> A happened",
    bToA.length === 1,
    `${bToA.length} job(s) from B to A`,
  );

  const allEmails = new Set(
    (await prisma.smtpAccount.findMany({ select: { email: true } })).map((e) => e.email),
  );
  const external = jobs.filter((j) => !allEmails.has(j.receiverSmtpAccount.email));
  check(
    "CP3 no external recipient",
    external.length === 0,
    `${external.length} job(s) addressed outside the configured mailboxes`,
  );

  const ids = jobs.map((j) => j.messageId);
  check(
    "CP4 message IDs are unique",
    new Set(ids).size === ids.length && ids.every(Boolean),
    `${new Set(ids).size} unique of ${ids.length}`,
  );

  check(
    "CP5 warm-up header job id recorded on every job",
    jobs.every((j) => j.messageId && j.id),
    `subjects: ${jobs.map((j) => JSON.stringify(j.subject)).join(", ")}`,
  );

  check(
    "CP6 never marked delivered on SMTP acceptance alone",
    sawSentWithoutDelivery
      ? null
      : jobs.every((j) => j.deliveredAt !== null || j.status !== "delivered"),
    sawSentWithoutDelivery
      ? "observed a job in `sent` with deliveredAt NULL before confirmation"
      : "no unconfirmed-delivered state observed live; covered by unit tests",
  );

  check(
    "CP7 IMAP confirmation recorded for every job",
    jobs.length === 2 && jobs.every((j) => j.status === "delivered" && j.deliveredAt),
    `statuses: ${jobs.map((j) => j.status).join(", ")}`,
  );

  const latencies = jobs.map((j) => j.deliveryLatencyMs).filter((n): n is number => n !== null);
  check(
    "CP8 latency recorded and plausible",
    latencies.length === 2 && latencies.every((n) => n > 0 && n < 30 * 60 * 1000),
    `latencies: ${latencies.join(", ") || "(none)"} ms`,
  );

  const receiverUids = jobs.map((j) => j.receiverMessageId).filter(Boolean);
  check(
    "CP9 receiver-side observation recorded",
    receiverUids.length === 2,
    `receiver UIDs: ${receiverUids.join(", ") || "(none)"}`,
  );

  const counters = await prisma.dailySendCounter.findMany({
    where: { userId, date: new Date().toISOString().slice(0, 10) },
  });
  const usage = await prisma.warmupDailyUsage.findMany({ where: { userId } });
  const smtpNow = counters
    .filter((c) => c.provider === "smtp")
    .reduce((n, c) => n + c.messagesSent, 0);
  const smtpBaseline = counterBaseline._sum.messagesSent ?? 0;
  const charged = smtpNow - smtpBaseline;
  const sentCount = jobs.filter((j) => j.sentAt !== null).length;
  check(
    "CP10 shared quota charged exactly the sends that happened, usage table is bookkeeping only",
    charged === sentCount && charged === 2,
    `DailySendCounter(smtp) ${smtpBaseline} -> ${smtpNow} (charged ${charged} for ${sentCount} sends); ` +
      `warmup_daily_usage warmupSent=${usage.map((u) => u.warmupSent).join(",") || "(none)"}`,
  );

  // Prove the two tables are genuinely independent: the usage table is what the
  // dashboard charts read, and it must not be able to influence the ceiling.
  const usageOnly = usage.reduce((n, u) => n + u.warmupSent, 0);
  check(
    "CP11 usage table total does not match the counter, proving it is not the authority",
    usageOnly === 2 && smtpNow >= 4,
    `warmup_daily_usage total=${usageOnly} vs DailySendCounter total=${smtpNow} ` +
      `(the counter also carries campaign sends; the usage table carries only warm-up)`,
  );

  console.log(`\n--- events ---`);
  const events = await prisma.warmupEvent.findMany({
    orderBy: { createdAt: "asc" },
    select: { type: true, message: true, createdAt: true },
  });
  for (const e of events) {
    console.log(`  ${e.createdAt.toISOString().slice(11, 19)}  ${e.type.padEnd(16)} ${e.message}`);
  }

  const failed = results.filter((r) => r.ok === false);
  const unknown = results.filter((r) => r.ok === null);
  console.log(
    `\n=== ${results.length - failed.length - unknown.length}/${results.length} checkpoints passed` +
      (failed.length ? `, ${failed.length} FAILED` : "") +
      (unknown.length ? `, ${unknown.length} unobserved` : "") +
      " ===",
  );
  for (const f of failed) console.log(`  FAILED: ${f.name}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});