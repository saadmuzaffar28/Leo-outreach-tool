/**
 * Warm-up worker integration tests.
 *
 * These run against a REAL Postgres (see helpers/test-db.ts) because the
 * behaviour under test is fundamentally about concurrency and transactions:
 * two workers claiming one job, a shared ceiling holding under racing
 * reservations, a paused mailbox producing no sends. None of that is
 * meaningfully testable against a mock.
 *
 * SMTP and IMAP are the ONLY things faked, via the module mocks below. Every
 * other layer -- routing, jobs, quota reservation, ramp, usage counters,
 * events, ownership checks -- is the real code path. Real network delivery is
 * covered separately and deliberately, against two of the operator's own
 * mailboxes; it does not belong in a suite that runs on every commit.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";

// ---------------------------------------------------------------------------
// Fake the network. Everything else is real.
// ---------------------------------------------------------------------------

const sendSmtpMail = vi.fn<(a: unknown, m: { to: string }) => Promise<unknown>>();
const confirmDelivery = vi.fn<(...a: never[]) => Promise<unknown>>();

vi.mock("@/lib/smtp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/smtp")>();
  return { ...actual, sendSmtpMail };
});

vi.mock("@/lib/warmup/imap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/warmup/imap")>();
  return { ...actual, confirmDelivery };
});

// ---------------------------------------------------------------------------

import { createUser, createSmtpAccount, enrollMailbox, setDailyLimit } from "./helpers/fixtures";
import { eligibleReceivers, pickReceiverPreferCrossDomain } from "@/lib/warmup/pool";
import type { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;
let service: typeof import("@/lib/warmup/service");
let worker: typeof import("@/lib/warmup/worker");
let quota: typeof import("@/lib/quota");

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  await startTestDatabase();
  // Prisma-backed modules are imported AFTER DATABASE_URL is set: a static
  // top-level import would construct the client against the placeholder URL
  // baked into vitest.config.ts and never reach the throwaway database.
  prisma = (await import("@/lib/prisma")).prisma;
  service = await import("@/lib/warmup/service");
  worker = await import("@/lib/warmup/worker");
  quota = await import("@/lib/quota");
  userId = (await createUser(prisma, "warmup-owner@test.example")).id;
  otherUserId = (await createUser(prisma, "warmup-stranger@test.example")).id;
  await setDailyLimit(prisma, userId, 100);
  await setDailyLimit(prisma, otherUserId, 100);
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(() => {
  sendSmtpMail.mockReset();
  sendSmtpMail.mockResolvedValue({ accepted: true, messageId: "smtp-accepted" });
  confirmDelivery.mockReset();
  confirmDelivery.mockResolvedValue({
    confirmed: false,
    latencyMs: 0,
    receiverMessageId: null,
    message: "not yet visible",
  });
});

/**
 * A tick walks EVERY enrolled, running mailbox in the database, not just the
 * one under test. Fixtures therefore accumulate across tests and later tests
 * would send traffic through mailboxes created by earlier ones, making call
 * counts depend on test order. Trimming to the two fixture users' data before
 * each test keeps every assertion about "exactly one send" meaningful.
 *
 * Deleting in FK order; the cascades handle the rest.
 */
async function resetFixtures(): Promise<void> {
  // Delete children before parents; the FK cascades handle anything missed.
  await prisma.warmupEvent.deleteMany({});
  await prisma.warmupJob.deleteMany({});
  await prisma.warmupDailyUsage.deleteMany({});
  await prisma.warmupMailboxSettings.deleteMany({});
  await prisma.dailySendCounter.deleteMany({});
  await prisma.smtpAccount.deleteMany({});
  // An earlier test may have lowered the ceiling; restore the default so a
  // limit-sensitive test is not silently capped by its predecessor.
  await setDailyLimit(prisma, userId, 100);
}

// Every test starts from an empty warm-up world, so call counts like
// "toHaveBeenCalledTimes(1)" mean what they say.
beforeEach(async () => {
  await resetFixtures();
});

const TODAY = () => quota.dailyKey();

/** Two enrolled, running mailboxes that can warm up to each other. */
async function pair(opts: { enabled?: boolean; limit?: number; startVolume?: number } = {}) {
  const a = await createSmtpAccount(prisma, userId, { email: `a-${Date.now()}@test.example` });
  const b = await createSmtpAccount(prisma, userId, { email: `b-${Date.now()}@test.example` });
  const ma = await enrollMailbox(prisma, userId, a.id, {
    enabled: true,
    status: "running",
    startingDailyVolume: opts.startVolume ?? 50,
    maximumDailyVolume: 50,
    minimumDelaySeconds: 5,
    maximumDelaySeconds: 5,
    warmupWindowStart: "00:00",
    warmupWindowEnd: "23:59",
  });
  const mb = await enrollMailbox(prisma, userId, b.id, {
    enabled: true,
    status: "running",
    startingDailyVolume: 50,
    maximumDailyVolume: 50,
    minimumDelaySeconds: 5,
    maximumDelaySeconds: 5,
    warmupWindowStart: "00:00",
    warmupWindowEnd: "23:59",
  });
  if (opts.limit) await setDailyLimit(prisma, userId, opts.limit);
  return { a, b, ma, mb };
}

/**
 * Force a job to be due now, since fixtures use a 5s delay.
 *
 * Uses a distinct past instant per call: WarmupJob carries
 * `@@unique([mailboxId, scheduledFor])`, so pulling two of the same mailbox's
 * jobs back to an identical "now - 1s" would violate that index and fail the
 * test for a reason that has nothing to do with the behaviour under test.
 */
let dueCursor = 0;
async function makeDue(jobId: string) {
  dueCursor += 1;
  return prisma.warmupJob.update({
    where: { id: jobId },
    data: { scheduledFor: new Date(Date.now() - 1000 - dueCursor) },
  });
}

// ===========================================================================
// 1. Worker execution: the happy path end to end (minus real sockets)
// ===========================================================================

describe("warm-up worker execution", () => {
  it("schedules, sends, and does NOT mark delivered on SMTP acceptance alone", async () => {
    const { ma } = await pair();

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(plan.action).toBe("schedule");
    expect(plan.job).toBeDefined();

    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("sent");
    expect(job.sentAt).not.toBeNull();

    // The decisive assertion of this test: SMTP accepting is not delivery.
    expect(job.deliveredAt).toBeNull();
    expect(job.deliveryLatencyMs).toBeNull();

    expect(sendSmtpMail).toHaveBeenCalledTimes(1);
    // It went to a real, owned, enrolled mailbox.
    expect(plan.job!.receiverEmail).toBe(sendSmtpMail.mock.calls[0][1].to);
  });

  it("records the send event and bumps daily usage", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const events = await service.warmupEvents(userId, { limit: 50, mailboxId: ma.id });
    const types = events.map((e) => e.type);
    expect(types).toContain("scheduled");
    expect(types).toContain("sent");

    const usage = await prisma.warmupDailyUsage.findUniqueOrThrow({
      where: { mailboxId_date: { mailboxId: ma.id, date: TODAY() } },
    });
    expect(usage.warmupSent).toBe(1);

    // Bookkeeping only. The authoritative ceiling lives on DailySendCounter,
    // and it counts RESERVATIONS: the send that just happened plus the fresh
    // job the same tick queued for this mailbox. warmup_daily_usage says 1
    // because nothing has been delivered yet -- the two are meant to differ.
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(2);
    expect(usage.delivered).toBe(0);
  });

  it("carries the warm-up headers and never campaign content", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const msg = sendSmtpMail.mock.calls[0][1] as unknown as { headers: Array<[string, string]>; subject: string };
    const headerNames = msg.headers.map(([k]) => k.toLowerCase());
    expect(headerNames).toContain("x-leo-warmup-job");
    expect(headerNames).toContain("x-leo-warmup-nonce");
    expect(headerNames).toContain("message-id");

    const jobIdHeader = msg.headers.find(([k]) => k.toLowerCase() === "x-leo-warmup-job")![1];
    expect(jobIdHeader).toMatch(/^[A-Za-z0-9_-]+$/);

    // No credential material anywhere in the headers.
    const blob = JSON.stringify(msg.headers);
    expect(blob.toLowerCase()).not.toContain("password");
    expect(blob.toLowerCase()).not.toContain("passwd");
  });

  it("never sends a message to a non-enrolled or external address", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const owned = new Set(
      (await prisma.smtpAccount.findMany({ where: { userId }, select: { email: true } })).map((r) => r.email),
    );
    for (const call of sendSmtpMail.mock.calls) {
      expect(owned.has((call[1] as { to: string }).to)).toBe(true);
    }
  });
});

// ===========================================================================
// 2. Duplicate / idempotent job execution
// ===========================================================================

describe("duplicate job execution", () => {
  it("a second worker cannot claim a job already being sent", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);

    // Two workers tick concurrently; exactly one send must happen.
    await Promise.all([worker.warmupTick(), worker.warmupTick()]);
    expect(sendSmtpMail).toHaveBeenCalledTimes(1);
  });

  it("does not re-send an already-sent job on later ticks", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);

    await worker.warmupTick();
    expect(sendSmtpMail).toHaveBeenCalledTimes(1);

    await worker.warmupTick();
    await worker.warmupTick();
    expect(sendSmtpMail).toHaveBeenCalledTimes(1);
  });

  it("increments attempts exactly once per claimed execution", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await Promise.all([worker.warmupTick(), worker.warmupTick()]);

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.attempts).toBe(1);
  });

  it("reclaims a job abandoned by a crashed worker via lease expiry", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    // Simulate a worker that claimed the job and then died.
    await prisma.warmupJob.update({
      where: { id: plan.job!.id },
      data: {
        status: "sending",
        claimedAt: new Date(Date.now() - 60_000),
        leaseExpiresAt: new Date(Date.now() - 1000),
        scheduledFor: new Date(Date.now() - 2000),
        attempts: 1,
      },
    });

    await worker.warmupTick();
    expect(sendSmtpMail).toHaveBeenCalledTimes(1);
    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("sent");
  });
});

// ===========================================================================
// 3. Shared campaign + warm-up quota
// ===========================================================================

describe("shared campaign + warm-up quota", () => {
  it("refuses to schedule once campaigns have consumed the shared ceiling", async () => {
    const { ma } = await pair({ limit: 10 });
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;

    // Campaigns already used 10 of 10 today.
    await quota.incrementDailyCounter("smtp", smtpId, userId, { kind: "sent", count: 10 }, TODAY());

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(plan.action).toBe("wait");
    expect(plan.reason).toMatch(/daily send limit/i);
  });

  it("divides one ceiling between campaigns and warm-up", async () => {
    const { ma } = await pair({ limit: 20 });
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;

    // 8 campaign sends happen first.
    await quota.incrementDailyCounter("smtp", smtpId, userId, { kind: "sent", count: 8 }, TODAY());

    // Warm-up may then use at most 12 of what is left, and no more.
    let scheduled = 0;
    for (let i = 0; i < 20; i++) {
      const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      if (p.action === "schedule") {
        scheduled++;
        await makeDue(p.job!.id);
      } else break;
    }

    expect(scheduled).toBeGreaterThan(0);
    // 20 total - 8 campaign = 12, NOT another 20.
    expect(scheduled).toBe(12);
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(20);
  });

  it("stops scheduling at the ramp target even with budget left", async () => {
    const { ma } = await pair({ startVolume: 3 });
    for (let i = 0; i < 10; i++) {
      const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      if (p.action !== "schedule") break;
      await makeDue(p.job!.id);
      await worker.warmupTick();
    }

    // The invariant is that the target caps COMMITTED work for the day, because
    // that is what protects the budget shared with real campaigns.
    //
    // This assertion used to be `warmupSent === 3`, and it passed while the
    // mailbox had actually scheduled SIX jobs -- `warmupTick` plans as well as
    // sends, so the count of completed sends was simply the wrong quantity to
    // measure. It is now stricter and measures the thing that was being broken.
    expect(await prisma.warmupJob.count({ where: { mailboxId: ma.id } })).toBe(3);

    const usage = await prisma.warmupDailyUsage.findUniqueOrThrow({
      where: { mailboxId_date: { mailboxId: ma.id, date: TODAY() } },
    });
    expect(usage.warmupSent).toBeLessThanOrEqual(3);
    expect(usage.warmupSent).toBeGreaterThan(0);

    const after = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(after.action).toBe("wait");
    expect(after.reason).toMatch(/ramp target/i);
  });

  it("does not overshoot the ramp target while jobs are still in flight", async () => {
    // The live A->B test sent 4 messages where 2 were intended. Cause: the ramp
    // gate counted `warmupSent`, which only advances when a message FINISHES
    // sending, while the worker re-plans on every 30s tick. A job sitting in
    // `queued` for its jittered delay was invisible, so every tick in that window
    // planned another message.
    //
    // The test above cannot catch that, because it runs a tick (and therefore a
    // send) between plans. This one deliberately does NOT -- it re-plans the way
    // the real worker does, with nothing completing in between.
    const { ma } = await pair({ startVolume: 2, limit: 100 });

    const planned: string[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      if (p.action !== "schedule") break;
      planned.push(p.job!.id);
    }

    // Target is 2 for the day. Two jobs, no more, however many times we look.
    expect(planned).toHaveLength(2);
    expect(await prisma.warmupJob.count({ where: { mailboxId: ma.id } })).toBe(2);

    // And the shared campaign budget was charged exactly twice, not once per
    // planning attempt.
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(2);
  });

  it("still allows the next day's higher target once the day rolls over", async () => {
    // Guards against the in-flight count being sticky: it is scoped to today's
    // UTC window, so yesterday's committed jobs must not suppress today's ramp.
    const { ma } = await pair({ startVolume: 1, limit: 100 });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Fill today's target.
    expect((await service.planNextSend({ userId, mailboxSettingsId: ma.id })).action).toBe("schedule");
    expect((await service.planNextSend({ userId, mailboxSettingsId: ma.id })).action).toBe("wait");

    // A planning pass "tomorrow" is no longer bounded by today's job.
    const nextDay = await service.planNextSend({
      userId,
      mailboxSettingsId: ma.id,
      now: tomorrow,
    });
    expect(nextDay.action).toBe("schedule");
  });
});

// ===========================================================================
// 4. SMTP failures: temporary retry vs permanent stop
// ===========================================================================

describe("SMTP failure handling", () => {
  it("retries a temporary failure with exponential backoff", async () => {
    const { ma } = await pair();
    sendSmtpMail.mockRejectedValueOnce(new Error("421 Service not available, closing transmission channel"));

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    // Not a permanent failure -> re-queued, not failed.
    expect(job.status).toBe("queued");
    expect(job.permanentError).toBe(false);
    expect(job.attempts).toBe(1);
    // Backoff pushed it into the future, so a tick right now must not resend.
    expect(job.scheduledFor.getTime()).toBeGreaterThan(Date.now());
  });

  it("backoff grows with each attempt", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);

    sendSmtpMail.mockRejectedValue(new Error("451 Requested action aborted: local error"));
    const gaps: number[] = [];
    for (let i = 0; i < 2; i++) {
      await worker.warmupTick();
      const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
      gaps.push(job.scheduledFor.getTime() - Date.now());
      await makeDue(plan.job!.id);
    }
    // Second retry waits longer than the first.
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
  });

  it("stops retrying a permanent auth failure and releases the budget", async () => {
    const { ma } = await pair({ limit: 20 });
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;

    sendSmtpMail.mockRejectedValue(new Error("535 5.7.8 Username and Password not accepted"));

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("failed");
    expect(job.permanentError).toBe(true);

    // The tick ALSO queued a fresh job for this mailbox, which holds one
    // reservation. So the count is 1, not 0 -- and specifically not 2, which is
    // what it would be if the failed send's slot had never been released.
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(1);

    // And a further tick must not retry a permanent failure.
    sendSmtpMail.mockClear();
    await worker.warmupTick();
    expect(sendSmtpMail).not.toHaveBeenCalled();
  });

  it("never retries a permanently-failed job, even once it is due again", async () => {
    const { ma } = await pair();
    sendSmtpMail.mockRejectedValue(new Error("550 5.1.1 The email account that you tried to reach does not exist"));
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();
    await makeDue(plan.job!.id);
    await worker.warmupTick();
    await worker.warmupTick();
    expect(sendSmtpMail).toHaveBeenCalledTimes(1);
  });

  it("auto-pauses the mailbox after the configured consecutive failures", async () => {
    const a = await createSmtpAccount(prisma, userId);
    const b = await createSmtpAccount(prisma, userId);
    const ma = await enrollMailbox(prisma, userId, a.id, {
      enabled: true, status: "running", startingDailyVolume: 50, maximumDailyVolume: 50,
      minimumDelaySeconds: 5, maximumDelaySeconds: 5,
      warmupWindowStart: "00:00", warmupWindowEnd: "23:59",
      maxConsecutiveFailures: 2, pauseOnError: true,
    });
    await enrollMailbox(prisma, userId, b.id, {
      enabled: true, status: "running", startingDailyVolume: 50, maximumDailyVolume: 50,
      minimumDelaySeconds: 5, maximumDelaySeconds: 5,
      warmupWindowStart: "00:00", warmupWindowEnd: "23:59",
    });

    sendSmtpMail.mockRejectedValue(new Error("535 5.7.8 Username and Password not accepted"));

    for (let i = 0; i < 2; i++) {
      const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      if (p.action !== "schedule") break;
      await makeDue(p.job!.id);
      await worker.warmupTick();
    }

    const after = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } });
    expect(after.status).toBe("paused_error");
    expect(after.enabled).toBe(false);
    // The operator needs to know WHY.
    expect(after.statusMessage).toMatch(/auto-paused/i);
  });

  it("does not auto-pause a transient blip below the threshold", async () => {
    const { ma } = await pair();
    sendSmtpMail.mockRejectedValueOnce(new Error("421 Service not available"));
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const after = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } });
    expect(after.status).toBe("running");
    expect(after.enabled).toBe(true);
  });
});

// ===========================================================================
// 5. IMAP verification
// ===========================================================================

describe("IMAP delivery verification", () => {
  it("marks delivered with latency only after IMAP confirms the exact message", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    confirmDelivery.mockResolvedValueOnce({
      confirmed: true, latencyMs: 4321, receiverMessageId: "msg-abc", message: "matched",
    });
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("delivered");
    expect(job.deliveryLatencyMs).toBe(4321);
    expect(job.deliveredAt).not.toBeNull();

    const usage = await prisma.warmupDailyUsage.findUniqueOrThrow({
      where: { mailboxId_date: { mailboxId: ma.id, date: TODAY() } },
    });
    expect(usage.delivered).toBe(1);

    const events = await service.warmupEvents(userId, { limit: 50, mailboxId: ma.id });
    expect(events.map((e) => e.type)).toContain("delivered");
  });

  it("keeps the job in 'sent' while IMAP has not seen it yet", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    // IMAP says "not there yet" -- must NOT become delivered.
    confirmDelivery.mockResolvedValue({ confirmed: false, latencyMs: 0, receiverMessageId: null, message: "not yet" });
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("sent");
    expect(job.deliveredAt).toBeNull();
  });

  it("marks 'unconfirmed' -- never 'delivered' -- when the message never arrives", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    // Push sentAt beyond the confirmation window, then clear the spy so the
    // assertion below is about THIS tick only -- the first tick legitimately
    // polled IMAP while the job was fresh.
    await prisma.warmupJob.update({
      where: { id: plan.job!.id },
      data: { sentAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    confirmDelivery.mockClear();
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("unconfirmed");
    expect(job.deliveredAt).toBeNull();
    // Too old to keep looking: the job is given up on WITHOUT claiming delivery.
    expect(confirmDelivery).not.toHaveBeenCalled();
  });

  it("reports unconfirmed when the receiving mailbox has no IMAP configured", async () => {
    const { ma } = await pair();
    // Point the receiver at a mailbox with no IMAP settings at all.
    await prisma.smtpAccount.updateMany({
      where: { userId },
      data: { imapHost: null, imapUsernameEncrypted: null, imapPasswordEncrypted: null, imapStatus: "unconfigured" },
    });

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();
    await worker.warmupTick();

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("unconfirmed");
    expect(job.lastError).toMatch(/imap/i);
    expect(job.deliveredAt).toBeNull();
  });

  it("survives an IMAP timeout without losing the job or double-counting", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    confirmDelivery.mockRejectedValue(new Error("ETIMEDOUT imap socket timeout"));
    await expect(worker.warmupTick()).rejects.toThrow(); // surfaced, not swallowed

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("sent");
    expect(job.deliveredAt).toBeNull();

    // A later tick recovers normally.
    confirmDelivery.mockResolvedValue({ confirmed: true, latencyMs: 10, receiverMessageId: "m", message: "ok" });
    await worker.warmupTick();
    expect((await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } })).status).toBe("delivered");
  });

  it("does not confirm the same job twice when workers overlap", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    // Force a genuine overlap. The naive version of this test just ran two
    // ticks with Promise.all and looked correct -- but it never actually
    // overlapped: the mocked IMAP call resolved instantly, so the first tick
    // finished confirming before the second reached its query. It passed even
    // with the double-counting bug present, which made it worthless as a
    // detector.
    //
    // Instead, hold every confirmDelivery call open until a SECOND one arrives,
    // with a timer as the release valve. With the claim working, only one call
    // is made and the timer opens the gate -> delivered === 1. With the claim
    // broken, both workers are inside IMAP together, the second arrival opens
    // the gate immediately, and both record a delivery -> 2.
    let arrivals = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const valve = setTimeout(open, 500);
    confirmDelivery.mockImplementation(async () => {
      arrivals += 1;
      if (arrivals >= 2) open();
      await gate;
      clearTimeout(valve);
      return { confirmed: true, latencyMs: 5, receiverMessageId: "m", message: "ok" };
    });

    await Promise.all([worker.warmupTick(), worker.warmupTick()]);
    clearTimeout(valve);

    const usage = await prisma.warmupDailyUsage.findUniqueOrThrow({
      where: { mailboxId_date: { mailboxId: ma.id, date: TODAY() } },
    });
    // Exactly one delivered count, not one per concurrent worker.
    expect(usage.delivered).toBe(1);
    // And IMAP was consulted once, not twice -- proving the second worker was
    // excluded at the claim rather than being corrected afterwards.
    expect(arrivals).toBe(1);
  });
});

// ===========================================================================
// 6. Pause / resume / reset / enable-disable
// ===========================================================================

describe("warm-up lifecycle controls", () => {
  it("pause stops scheduling; resume restarts it", async () => {
    const { a, ma } = await pair();
    const paused = await service.pauseWarmup(userId, a.id);
    expect(paused.ok).toBe(true);

    const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    // planNextSend refuses outright ("stop") when the mailbox is not running:
    // there is nothing to wait for.
    expect(p.action).toBe("stop");

    const resumed = await service.startWarmup(userId, a.id);
    expect(resumed.ok).toBe(true);
    const p2 = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(p2.action).toBe("schedule");
  });

  it("a paused mailbox produces no sends on tick", async () => {
    const { a, ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);

    await service.pauseWarmup(userId, a.id);
    await worker.warmupTick();

    expect(sendSmtpMail).not.toHaveBeenCalled();
    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("cancelled");
  });

  it("requires a manual resume after an error auto-pause, and clears the reason", async () => {
    const a = await createSmtpAccount(prisma, userId);
    const b = await createSmtpAccount(prisma, userId);
    const ma = await enrollMailbox(prisma, userId, a.id, {
      enabled: true, status: "paused_error", startingDailyVolume: 50, maximumDailyVolume: 50,
      minimumDelaySeconds: 5, maximumDelaySeconds: 5,
      warmupWindowStart: "00:00", warmupWindowEnd: "23:59",
      consecutiveFailures: 3,
    });
    await enrollMailbox(prisma, userId, b.id, {
      enabled: true, status: "running", startingDailyVolume: 50, maximumDailyVolume: 50,
      minimumDelaySeconds: 5, maximumDelaySeconds: 5,
      warmupWindowStart: "00:00", warmupWindowEnd: "23:59",
    });
    await prisma.warmupMailboxSettings.update({
      where: { id: ma.id },
      data: { statusMessage: "Auto-paused after 3 consecutive failures: auth failed" },
    });

    // Nothing self-heals.
    await worker.warmupTick();
    const still = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } });
    expect(still.status).toBe("paused_error");

    const resumed = await service.startWarmup(userId, a.id);
    expect(resumed.ok).toBe(true);
    const after = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } });
    expect(after.status).toBe("running");
    expect(after.consecutiveFailures).toBe(0);
    expect(after.statusMessage).toBeNull();
  });

  it("reset returns the ramp to day 1 and releases reserved budget", async () => {
    const { a, ma } = await pair({ limit: 20 });
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(1);

    const res = await service.resetWarmup(userId, a.id);
    expect(res.ok).toBe(true);

    // Budget must not be stranded for the rest of the day.
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(0);

    const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
    expect(job.status).toBe("cancelled");

    const settings = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } });
    expect(settings.currentDay).toBe(0);
    expect(settings.lastActiveDate).toBeNull();
  });

  it("a disabled mailbox never schedules anything", async () => {
    const { a, ma } = await pair();
    await prisma.warmupMailboxSettings.update({ where: { id: ma.id }, data: { enabled: false, status: "paused" } });
    const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(p.action).toBe("stop");
    await worker.warmupTick();
    expect(sendSmtpMail).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Enrollment deadlock regression coverage (A-H).
  //
  // Enrollment and SENDING are deliberately separate conditions:
  //   enrollment -> the operator may enrol the FIRST mailbox with no partner
  //   sending    -> needs a valid receiver, so it needs a SECOND mailbox
  //
  // Every assertion below runs the real service/worker path against the real
  // Postgres. No assertion here can pass vacuously: job counts are compared to
  // exact values, and every "must not happen" claim is checked by inspecting
  // the rows that were actually written.
  // =========================================================================
  describe("enrollment deadlock regression (A-H)", () => {
    it("A: the first mailbox can be enrolled when zero mailboxes are enrolled", async () => {
      // Precondition, asserted rather than assumed: the pool really is empty.
      expect(await service.loadPool(userId)).toHaveLength(0);

      const a = await createSmtpAccount(prisma, userId, { email: `first-${Date.now()}@test.example` });
      const res = await service.startWarmup(userId, a.id);

      expect(res.ok).toBe(true);
      expect(res.status).toBe("running");
      expect(res.message).not.toMatch(/at least one other/i);

      // Persisted state, read back from the database.
      const s = await prisma.warmupMailboxSettings.findUniqueOrThrow({
        where: { smtpAccountId: a.id },
      });
      expect(s.enabled).toBe(true);
      expect(s.status).toBe("running");
      expect(s.statusMessage).toBeNull();

      // It really is in the pool afterwards.
      expect((await service.loadPool(userId)).map((m) => m.id)).toEqual([a.id]);
    });

    it("B: with exactly ONE enrolled mailbox no warm-up send is created", async () => {
      const a = await createSmtpAccount(prisma, userId, { email: `solo-${Date.now()}@test.example` });
      const ma = await enrollMailbox(prisma, userId, a.id, {
        enabled: true,
        status: "running",
        startingDailyVolume: 50,
        maximumDailyVolume: 50,
        minimumDelaySeconds: 5,
        maximumDelaySeconds: 5,
        warmupWindowStart: "00:00",
        warmupWindowEnd: "23:59",
      });

      // Precondition: exactly one enrolled mailbox, and it is running.
      expect(await service.loadPool(userId)).toHaveLength(1);
      const pre = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } });
      expect(pre.enabled).toBe(true);
      expect(pre.status).toBe("running");

      // Drive the REAL planning path.
      const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });

      expect(plan.action).toBe("stop");
      expect(plan.reason).toMatch(/no other enrolled warm-up mailbox/i);
      expect(plan.job).toBeUndefined();

      // Exact count, not a tautology: no job row exists.
      expect(await prisma.warmupJob.count()).toBe(0);

      // And the worker tick must not send either.
      await worker.warmupTick();
      expect(sendSmtpMail).not.toHaveBeenCalled();
      expect(await prisma.warmupJob.count()).toBe(0);
    });

    it("C: with TWO enrolled mailboxes a valid cross-mailbox job is planned", async () => {
      const { a, b, ma } = await pair();
      expect(await service.loadPool(userId)).toHaveLength(2);

      const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });

      expect(plan.action).toBe("schedule");
      expect(plan.job).toBeDefined();
      expect(plan.job!.receiverEmail).toBe(b.email);

      // The FK columns live on the persisted row, not on the plan's summary.
      const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
      expect(job.senderSmtpAccountId).toBe(a.id);
      expect(job.receiverSmtpAccountId).toBe(b.id);

      // The two ends must differ.
      expect(job.senderSmtpAccountId).not.toBe(job.receiverSmtpAccountId);

      // Persisted exactly one job, between two distinct mailboxes.
      const rows = await prisma.warmupJob.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].senderSmtpAccountId).not.toBe(rows[0].receiverSmtpAccountId);
    });

    it("D: the sender can never select itself as the receiver", async () => {
      // Pure-function level: a one-member pool yields no receiver at all.
      const solo = { id: "solo-1", email: "solo@test.example" };
      expect(pickReceiverPreferCrossDomain([solo], solo, 0)).toBeNull();
      expect(eligibleReceivers([solo], solo)).toHaveLength(0);

      // Service level: sweep the rotation cursor so no offset can slip through.
      const { a, ma } = await pair();
      for (const cursor of [0, 1, 2, 3, 4, 5]) {
        const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id, cursor });
        expect(plan.action).toBe("schedule");
        expect(plan.job!.receiverEmail).not.toBe(a.email);
        const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
        expect(job.receiverSmtpAccountId).not.toBe(a.id);
      }

      // No self-directed job exists in the table, whatever was planned.
      const rows = await prisma.warmupJob.findMany();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.senderSmtpAccountId).not.toBe(r.receiverSmtpAccountId);
      }
    });

    it("E: a non-enrolled external address can never become a warm-up receiver", async () => {
      const { ma } = await pair();

      // An SMTP account that exists but was never enrolled in warm-up.
      const outsider = await createSmtpAccount(prisma, userId, {
        email: `outsider-${Date.now()}@elsewhere.example`,
      });
      // A mailbox belonging to a different user.
      const stranger = await createSmtpAccount(prisma, otherUserId, {
        email: `stranger-${Date.now()}@elsewhere.example`,
      });

      const pool = await service.loadPool(userId);
      expect(pool).toHaveLength(2);
      expect(pool.map((m) => m.id)).not.toContain(outsider.id);
      expect(pool.map((m) => m.id)).not.toContain(stranger.id);

      for (const cursor of [0, 1, 2, 3]) {
        const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id, cursor });
        expect(plan.action).toBe("schedule");

        const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
        const receiverId = job.receiverSmtpAccountId;
        expect(receiverId).not.toBe(outsider.id);
        expect(receiverId).not.toBe(stranger.id);

        // The receiver resolves to a real SmtpAccount owned by this user...
        const acct = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: receiverId } });
        expect(acct.userId).toBe(userId);
        expect(acct.email).not.toMatch(/elsewhere\.example/);

        // ...and that account is an ENABLED, enrolled warm-up mailbox.
        const rec = await prisma.warmupMailboxSettings.findUniqueOrThrow({
          where: { smtpAccountId: receiverId },
        });
        expect(rec.enabled).toBe(true);
      }

      // Every receiver that actually landed in the table is an enrolled mailbox.
      const rows = await prisma.warmupJob.findMany();
      expect(rows.length).toBeGreaterThan(0);
      const enrolled = new Set((await service.loadPool(userId)).map((m) => m.id));
      for (const r of rows) expect(enrolled.has(r.receiverSmtpAccountId)).toBe(true);
    });

    it("F: the daily ceiling is per mailbox (provider/accountId/date), not shared", async () => {
      const { a, b, ma } = await pair({ limit: 2 });

      // Exhaust mailbox A's ceiling of 2 for today. reserveDailySlot returns a
      // boolean: true = a slot was consumed, false = the ceiling rejected it.
      expect(await quota.reserveDailySlot("smtp", a.id, userId, 2)).toBe(true);
      expect(await quota.reserveDailySlot("smtp", a.id, userId, 2)).toBe(true);
      expect(await quota.reserveDailySlot("smtp", a.id, userId, 2)).toBe(false);

      // Mailbox B is untouched: the counter is keyed by accountId.
      expect(await quota.reserveDailySlot("smtp", b.id, userId, 2)).toBe(true);
      expect(await quota.reserveDailySlot("smtp", b.id, userId, 2)).toBe(true);
      expect(await quota.reserveDailySlot("smtp", b.id, userId, 2)).toBe(false);

      // Two independent rows, one per mailbox, both for today under "smtp".
      const rows = await prisma.dailySendCounter.findMany({ where: { userId } });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.accountId).sort()).toEqual([a.id, b.id].sort());
      for (const r of rows) {
        expect(r.provider).toBe("smtp");
        expect(r.date).toBe(TODAY());
        expect(r.messagesSent).toBe(2);
      }

      // The planning path refuses to plan for a mailbox that is at its ceiling.
      const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      expect(plan.action).toBe("wait");
      expect(plan.reason).toMatch(/daily send limit/i);
      expect(plan.job).toBeUndefined();
      expect(await prisma.warmupJob.count()).toBe(0);
    });

    it("G: the master warmupEnabled gate still blocks planning and sending", async () => {
      const { ma } = await pair();
      // Two enrolled mailboxes, so ONLY the master switch can be the blocker.
      expect(await service.loadPool(userId)).toHaveLength(2);

      await setDailyLimit(prisma, userId, 100, false); // warmupEnabled = false

      const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      expect(plan.action).toBe("stop");
      expect(plan.reason).toMatch(/switched off in settings/i);
      expect(plan.job).toBeUndefined();
      expect(await prisma.warmupJob.count()).toBe(0);

      // The worker respects it too.
      await worker.warmupTick();
      expect(sendSmtpMail).not.toHaveBeenCalled();
      expect(await prisma.warmupJob.count()).toBe(0);

      // Restore for test hygiene (beforeEach resets this anyway).
      await setDailyLimit(prisma, userId, 100, true);
      const after = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
      expect(after.action).toBe("schedule");
    });

    it("H: receiver candidates are enrolled+enabled only, and never the sender", async () => {
      // Pure level: same-address rows and the sender itself are excluded.
      const pool = [
        { id: "1", email: "a@corp.example" },
        { id: "2", email: "a@corp.example" }, // duplicate address
        { id: "3", email: "b@other.example" }, // cross-domain
      ];
      const sender = { id: "1", email: "a@corp.example" };

      expect(eligibleReceivers(pool, sender).map((m) => m.id)).toEqual(["3"]);
      // Cross-domain preference selects 3, and cannot select anything ineligible.
      expect(pickReceiverPreferCrossDomain(pool, sender, 0)!.id).toBe("3");
      for (const cursor of [0, 1, 2, 3, 4]) {
        expect(pickReceiverPreferCrossDomain(pool, sender, cursor)!.id).toBe("3");
      }

      // Database level: an ENROLLED BUT DISABLED mailbox is not a candidate.
      const { a, b, ma } = await pair();
      const c = await createSmtpAccount(prisma, userId, { email: `c-${Date.now()}@test.example` });
      await enrollMailbox(prisma, userId, c.id, { enabled: false, status: "paused" });

      const poolIds = (await service.loadPool(userId)).map((m) => m.id);
      expect(poolIds).toHaveLength(2);
      expect(poolIds).not.toContain(c.id);

      for (const cursor of [0, 1, 2, 3]) {
        const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id, cursor });
        expect(plan.action).toBe("schedule");
        const job = await prisma.warmupJob.findUniqueOrThrow({ where: { id: plan.job!.id } });
        expect(job.receiverSmtpAccountId).not.toBe(c.id);
        expect([a.id, b.id]).toContain(job.receiverSmtpAccountId);
      }
    });
  });

  it("will not schedule when the SMTP account is disconnected", async () => {
    const { a, ma } = await pair();
    await prisma.smtpAccount.update({ where: { id: a.id }, data: { status: "error" } });
    const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(p.action).toBe("wait");
    expect(p.reason).toMatch(/error/i);
  });

  it("schedules nothing outside the warm-up window", async () => {
    const { ma, mb } = await pair();
    // `when` is fixed, so the assertion holds regardless of what time the suite
    // happens to run at.
    const when = new Date("2026-03-04T12:00:00Z");
    await prisma.warmupMailboxSettings.update({
      where: { id: ma.id },
      data: { warmupWindowStart: "22:00", warmupWindowEnd: "23:00" },
    });
    await prisma.warmupMailboxSettings.update({
      where: { id: mb.id },
      data: { warmupWindowStart: "22:00", warmupWindowEnd: "23:00" },
    });

    const before = await prisma.warmupJob.count();
    // The window gate lives in the tick, which is the only production caller of
    // planNextSend -- so that is where it has to be asserted.
    await worker.warmupTick(when);
    expect(await prisma.warmupJob.count()).toBe(before);
    expect(sendSmtpMail).not.toHaveBeenCalled();
  });

  it("schedules inside the warm-up window", async () => {
    const { ma, mb } = await pair();
    const when = new Date("2026-03-04T12:00:00Z");
    for (const id of [ma.id, mb.id]) {
      await prisma.warmupMailboxSettings.update({
        where: { id },
        data: { warmupWindowStart: "09:00", warmupWindowEnd: "17:00" },
      });
    }
    const before = await prisma.warmupJob.count();
    await worker.warmupTick(when);
    expect(await prisma.warmupJob.count()).toBeGreaterThan(before);
  });
});

// ===========================================================================
// 7. Pool behaviour: no self-send, rotation, ownership
// ===========================================================================

describe("warm-up pool", () => {
  it("never sends a mailbox a message to itself", async () => {
    const { a, ma } = await pair();
    for (let i = 0; i < 6; i++) {
      const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id, cursor: i });
      if (p.action !== "schedule") continue;
      expect(p.job!.receiverEmail).not.toBe(
        (await prisma.smtpAccount.findUniqueOrThrow({ where: { id: a.id } })).email,
      );
    }
  });

  it("rotates the receiver across the enrolled pool", async () => {
    const a = await createSmtpAccount(prisma, userId);
    const b = await createSmtpAccount(prisma, userId);
    const c = await createSmtpAccount(prisma, userId);
    const ma = await enrollMailbox(prisma, userId, a.id, {
      enabled: true, status: "running", startingDailyVolume: 50, maximumDailyVolume: 50,
      minimumDelaySeconds: 5, maximumDelaySeconds: 5, warmupWindowStart: "00:00", warmupWindowEnd: "23:59",
    });
    for (const acct of [b, c]) {
      await enrollMailbox(prisma, userId, acct.id, {
        enabled: true, status: "running", startingDailyVolume: 50, maximumDailyVolume: 50,
        minimumDelaySeconds: 5, maximumDelaySeconds: 5, warmupWindowStart: "00:00", warmupWindowEnd: "23:59",
      });
    }

    const chosen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id, cursor: i });
      if (p.action === "schedule") chosen.add(p.job!.receiverEmail);
    }
    // With three enrolled mailboxes the sender must reach more than one peer.
    expect(chosen.size).toBeGreaterThan(1);
  });

  it("excludes a disabled peer from the pool", async () => {
    const { ma, mb } = await pair();
    // Target the peer EXPLICITLY. An earlier version looked it up with
    // `orderBy: { createdAt: "desc" }`, which is a coin flip whenever `ma` and
    // `mb` are inserted in the same millisecond -- the tie is broken arbitrarily,
    // so the test intermittently disabled the wrong mailbox and failed. Naming
    // the row removes the ambiguity entirely.
    await prisma.warmupMailboxSettings.update({
      where: { id: mb.id }, data: { enabled: false, status: "paused" },
    });

    const p = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    // No enabled partner left -> refuse rather than reach outside the pool.
    expect(p.action).toBe("stop");
    expect(p.reason).toMatch(/enrolled/i);
  });

  it("another user's mailbox is invisible and cannot be targeted", async () => {
    const { ma } = await pair();
    const stranger = await createSmtpAccount(prisma, otherUserId, { email: "stranger@test.example" });
    await enrollMailbox(prisma, otherUserId, stranger.id, { enabled: true, status: "running" });

    // The pool is scoped by userId, so the stranger cannot appear.
    const pool = await service.loadPool(userId);
    expect(pool.map((p) => p.id)).not.toContain(stranger.id);

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(plan.job!.receiverEmail).not.toBe("stranger@test.example");
  });

  it("will not plan for a mailbox the caller does not own", async () => {
    const { ma } = await pair();
    const p = await service.planNextSend({ userId: otherUserId, mailboxSettingsId: ma.id });
    expect(p.action).toBe("stop");
    expect(p.reason).toMatch(/not found/i);
  });

  it("start/pause/reset refuse to touch another user's mailbox", async () => {
    const { a } = await pair();
    expect((await service.startWarmup(otherUserId, a.id)).ok).toBe(false);
    expect((await service.pauseWarmup(otherUserId, a.id)).ok).toBe(false);
    expect((await service.resetWarmup(otherUserId, a.id)).ok).toBe(false);

    // And the owner's state is untouched.
    const ownerView = await service.listWarmupMailboxes(userId);
    expect(ownerView.some((m) => m.smtpAccountId === a.id)).toBe(true);
  });
});

// ===========================================================================
// 8. Credentials must never leave the server
// ===========================================================================

describe("credentials never reach the client", () => {
  it("listWarmupMailboxes exposes no SMTP or IMAP secret", async () => {
    const { a } = await pair();
    const views = await service.listWarmupMailboxes(userId);
    const mine = views.find((v) => v.smtpAccountId === a.id)!;
    const blob = JSON.stringify(mine).toLowerCase();

    for (const forbidden of ["password", "passwd", "encrypted", "usernameencrypted", "secret", "token", "apikey"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("stats and events expose no credentials either", async () => {
    const { a, ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const stats = JSON.stringify(await service.warmupStats(userId, 30, a.id)).toLowerCase();
    const events = JSON.stringify(await service.warmupEvents(userId, { limit: 100 })).toLowerCase();

    for (const forbidden of ["password", "encrypted", "secret", "credential"]) {
      expect(stats).not.toContain(forbidden);
      expect(events).not.toContain(forbidden);
    }
  });

  it("the decrypted password is never written into an event or usage row", async () => {
    const { ma } = await pair();
    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    await makeDue(plan.job!.id);
    await worker.warmupTick();

    const events = await prisma.warmupEvent.findMany();
    const jobs = await prisma.warmupJob.findMany();
    const blob = JSON.stringify({ events, jobs }).toLowerCase();
    // The fixture encrypts exactly this password.
    expect(blob).not.toContain("super-secret-password");
  });
});

// ===========================================================================
// 9. Global kill switch
// ===========================================================================

describe("global warm-up switch", () => {
  it("sends nothing at all when no mailbox is enabled", async () => {
    const { ma } = await pair();
    await prisma.warmupMailboxSettings.updateMany({ data: { enabled: false, status: "paused" } });
    await worker.warmupTick();
    expect(sendSmtpMail).not.toHaveBeenCalled();
    expect(await prisma.warmupJob.count()).toBe(0);
  });

  it("the default state of a freshly enrolled mailbox is OFF", async () => {
    const a = await createSmtpAccount(prisma, userId);
    const settings = await service.ensureWarmupSettings(userId, a.id);
    expect(settings.enabled).toBe(false);
    expect(settings.status).toBe("paused");
  });

  it("the user-level switch refuses to schedule even for an enabled mailbox", async () => {
    // The switch was previously read by NOTHING: it was returned by
    // GET/PUT /api/warmup/settings and shown in the dashboard, but the only
    // enforced gate was the per-mailbox `enabled` flag. An operator turning it
    // off would have watched the toggle move and kept receiving warm-up mail.
    const { ma } = await pair({ limit: 100 });
    await setDailyLimit(prisma, userId, 100, false);

    const plan = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(plan.action).toBe("stop");
    expect(plan.reason).toMatch(/switched off/i);
    expect(plan.job).toBeUndefined();
  });

  it("turning the switch back on resumes scheduling", async () => {
    const { ma } = await pair({ limit: 100 });
    await setDailyLimit(prisma, userId, 100, false);
    expect((await service.planNextSend({ userId, mailboxSettingsId: ma.id })).action).toBe("stop");

    await setDailyLimit(prisma, userId, 100, true);
    const resumed = await service.planNextSend({ userId, mailboxSettingsId: ma.id });
    expect(resumed.action).toBe("schedule");
  });

  it("the worker sends nothing while the switch is off, even for enabled mailboxes", async () => {
    // End-to-end through the real tick, because a gate enforced in the service
    // could still be bypassed by the worker if it scheduled some other way.
    const { ma } = await pair({ limit: 100 });
    await setDailyLimit(prisma, userId, 100, false);

    await worker.warmupTick();
    expect(await prisma.warmupJob.count()).toBe(0);
    expect(sendSmtpMail).not.toHaveBeenCalled();
    // ...and it must not have burned any of the shared budget either.
    const smtpId = (await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { id: ma.id } })).smtpAccountId;
    expect((await quota.getDailyCounter("smtp", smtpId, userId, TODAY())).messagesSent).toBe(0);
  });

  it("a fresh user with default settings cannot warm up at all", async () => {
    // Defaults are OFF. Proved from a clean SendSettings row rather than a
    // fixture that opted in, so the default itself is under test.
    const other = await createUser(prisma, `switch-default-${Date.now()}@test.example`);
    const x = await createSmtpAccount(prisma, other.id, { email: `x-${Date.now()}@test.example` });
    const y = await createSmtpAccount(prisma, other.id, { email: `y-${Date.now()}@test.example` });
    const mx = await enrollMailbox(prisma, other.id, x.id, {
      enabled: true,
      status: "running",
      startingDailyVolume: 10,
      maximumDailyVolume: 10,
      minimumDelaySeconds: 5,
      maximumDelaySeconds: 5,
      warmupWindowStart: "00:00",
      warmupWindowEnd: "23:59",
    });
    await enrollMailbox(prisma, other.id, y.id, {
      enabled: true,
      status: "running",
      startingDailyVolume: 10,
      maximumDailyVolume: 10,
      minimumDelaySeconds: 5,
      maximumDelaySeconds: 5,
      warmupWindowStart: "00:00",
      warmupWindowEnd: "23:59",
    });

    const plan = await service.planNextSend({ userId: other.id, mailboxSettingsId: mx.id });
    expect(plan.action).toBe("stop");
  });
});