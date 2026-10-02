import { prisma } from "@/lib/prisma";
import { decryptSmtpCredentials, sendSmtpMail, classifySmtpError } from "@/lib/smtp";
import { isWithinWindow } from "@/lib/warmup/ramp";
import {
  planNextSend,
  recordEvent,
  bumpWarmupUsage,
  releaseSlotFor,
  headersForJob,
} from "@/lib/warmup/service";
import { confirmDelivery, imapConfigFor } from "@/lib/warmup/imap";
import { dailyKey } from "@/lib/quota";

/**
 * Dedicated WarmupWorker.
 *
 * SEPARATE FROM THE CAMPAIGN WORKER on purpose: it runs its own loop, its own
 * queue (WarmupJob), and shares only the per-mailbox daily budget. A warm-up
 * bug therefore cannot stall or duplicate campaign sends.
 *
 * SAFE FOR MULTIPLE INSTANCES. Every transition is a conditional UPDATE whose
 * WHERE clause asserts the current status, so exactly one worker can win a
 * claim even if several run. Jobs carry a lease so a crashed worker's job is
 * reclaimable, and the daily budget slot is reserved atomically.
 *
 * It does NOT bypass anything: the shared daily limit, suppression, mailbox
 * enabled/connected state and the pause state are all checked before a send.
 */

const TICK_MS = 30_000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
/** How long we keep re-checking IMAP for an unconfirmed message. */
const IMAP_CONFIRM_WINDOW_MS = 30 * 60 * 1000;

/** SMTP codes that will never succeed on retry. */
const PERMANENT_SMTP = /5\.1\.[01]|5\.7\.[01]|invalid recipient|does not exist|blocked|unauthenticated|invalid credentials/i;

interface DueJob {
  id: string;
  attempts: number;
  scheduledFor: Date;
  mailboxId: string;
  senderSmtpAccountId: string;
  receiverSmtpAccountId: string;
  messageId: string;
  subject: string;
  sentAt: Date | null;
}

/**
 * Atomically claim a due job. The WHERE clause is the whole concurrency story:
 * only a job that is still `queued` (or whose lease has expired) can move to
 * `sending`, so a second worker sees count 0 and skips it.
 */
async function claimJob(jobId: string): Promise<boolean> {
  const now = new Date();
  const res = await prisma.warmupJob.updateMany({
    where: {
      id: jobId,
      status: "queued",
      scheduledFor: { lte: now },
    },
    data: {
      status: "sending",
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      attempts: { increment: 1 },
    },
  });
  return res.count === 1;
}

/**
 * Reclaim a job whose worker died mid-send. The lease expiry is the only way a
 * `sending` job becomes claimable again, so this can never race a live worker.
 */
async function reclaimStaleJobs(): Promise<void> {
  const now = new Date();
  const res = await prisma.warmupJob.updateMany({
    where: { status: "sending", leaseExpiresAt: { lt: now } },
    data: { status: "queued", leaseExpiresAt: null },
  });

  // Same idea for a worker that died while confirming delivery: the job is
  // legitimately `sent`, but it is holding a lease nobody will ever release.
  // Without this it would sit unconfirmed forever, even though the message may
  // well be sitting in the receiving inbox right now.
  await prisma.warmupJob.updateMany({
    where: { status: "sent", leaseExpiresAt: { lt: now } },
    data: { leaseExpiresAt: null },
  });
  if (res.count > 0) {
    console.log(`[warmup] reclaimed ${res.count} stale job(s) after lease expiry`);
  }
}

async function sendOne(job: DueJob): Promise<void> {
  const [sender, receiver] = await Promise.all([
    prisma.smtpAccount.findUnique({ where: { id: job.senderSmtpAccountId } }),
    prisma.smtpAccount.findUnique({ where: { id: job.receiverSmtpAccountId } }),
  ]);
  if (!sender || !receiver) {
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: { status: "failed", lastError: "Mailbox missing", failureKind: "permanent", permanentError: true },
    });
    await releaseSlotFor(job.senderSmtpAccountId);
    return;
  }

  // Re-check the mailbox is still allowed to send, at the moment of sending.
  const m = await prisma.warmupMailboxSettings.findUnique({ where: { id: job.mailboxId } });
  if (!m || !m.enabled || m.status !== "running") {
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: { status: "cancelled", lastError: "Mailbox no longer running", leaseExpiresAt: null },
    });
    await releaseSlotFor(job.senderSmtpAccountId);
    return;
  }
  if (sender.status !== "connected") {
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: { status: "queued", lastError: `SMTP account is ${sender.status}`, leaseExpiresAt: null },
    });
    return; // keep the reservation; retry later
  }

  const creds = decryptSmtpCredentials({
    usernameEncrypted: sender.usernameEncrypted,
    passwordEncrypted: sender.passwordEncrypted,
  });
  const content = { subject: job.subject, text: "Automated internal warm-up message between your own mailboxes.", html: undefined };

  try {
    await sendSmtpMail(
      {
        email: sender.email,
        host: sender.host,
        port: sender.port,
        security: sender.security as "ssl" | "starttls" | "none",
        username: creds.username,
        password: creds.password,
      },
      {
        to: receiver.email,
        subject: content.subject,
        html: `<p>${content.text}</p>`,
        text: content.text,
        headers: headersForJob({
          id: job.id,
          messageId: job.messageId,
          senderEmail: sender.email,
          receiverEmail: receiver.email,
          subject: job.subject,
        }),
      },
    );

    // SMTP accepted. NOT yet "delivered" -- IMAP must confirm it.
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: { status: "sent", sentAt: new Date(), lastError: null, leaseExpiresAt: null },
    });
    await recordEvent(m.userId, m.id, "sent", `SMTP accepted by ${sender.email}`, job.id);
    await bumpWarmupUsage(m.userId, m.id, { warmupSent: 1 });
  } catch (err) {
    const smtpErr = classifySmtpError(err);
    // Permanent means "retrying cannot help": bad credentials, a broken
    // configuration, or an address that does not exist. A TEMPORARY
    // classification (any 4xx) is exactly what backoff exists for, so it must
    // NOT land here -- otherwise a provider politely saying "421 try again
    // later" would permanently abandon the job.
    const permanent =
      smtpErr.code === "AUTH_FAILED" ||
      smtpErr.code === "INVALID_CONFIG" ||
      PERMANENT_SMTP.test(smtpErr.userMessage);

    await prisma.warmupJob.update({
      where: { id: job.id },
      data: {
        status: permanent ? "failed" : "queued",
        lastError: smtpErr.userMessage.slice(0, 400),
        failureKind: permanent ? (smtpErr.code === "AUTH_FAILED" ? "auth" : "permanent") : "temporary",
        permanentError: permanent,
        leaseExpiresAt: null,
        // Retry temporary failures with exponential backoff.
        // `job.attempts` is the value read BEFORE claimJob incremented it, so
        // add one to get the attempt number this failure actually was. Without
        // that, the first retry computes backoffMs(0) and the schedule runs one
        // step behind the real attempt count.
        scheduledFor: permanent
          ? job.scheduledFor
          : new Date(Date.now() + backoffMs(job.attempts + 1)),
      },
    });
    await recordEvent(m.userId, m.id, "smtp_failed", smtpErr.userMessage.slice(0, 300), job.id, {
      permanent,
      code: smtpErr.code,
    });
    await bumpWarmupUsage(m.userId, m.id, { warmupFailed: 1 });

    if (permanent) {
      // Release the budget we reserved: the message never went out.
      await releaseSlotFor(job.senderSmtpAccountId);
      await noteFailure(m.id, m.userId, smtpErr.userMessage, job.id);
    }
  }
}

/**
 * Exponential backoff for a temporary failure.
 *
 * `attempt` is 1-based: the first failed attempt waits the base delay, and each
 * subsequent one doubles, capped at 30 minutes so a mailbox is never parked for
 * hours by a provider that stays briefly unhappy.
 */
function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

/** Increment consecutive failures and pause the mailbox at the threshold. */
async function noteFailure(mailboxId: string, userId: string, reason: string, jobId: string): Promise<void> {
  const m = await prisma.warmupMailboxSettings.findUnique({ where: { id: mailboxId } });
  if (!m) return;
  const failures = m.consecutiveFailures + 1;
  const shouldPause = m.pauseOnError && failures >= m.maxConsecutiveFailures;
  await prisma.warmupMailboxSettings.update({
    where: { id: mailboxId },
    data: {
      consecutiveFailures: failures,
      consecutiveSuccessfulDays: 0,
      ...(shouldPause
        ? { status: "paused_error", statusMessage: `Auto-paused after ${failures} consecutive failures: ${reason}`.slice(0, 400), enabled: false }
        : {}),
    },
  });
  if (shouldPause) {
    await recordEvent(userId, mailboxId, "paused", `Auto-paused after ${failures} failures: ${reason}`.slice(0, 300), jobId);
  }
}

/**
 * Confirm delivery for a sent-but-unconfirmed job by actually looking in the
 * receiving mailbox. NEVER marks delivered on SMTP acceptance alone.
 */
async function confirmOne(job: DueJob & { userId: string }): Promise<void> {
  if (!job.sentAt) return;
  const age = Date.now() - job.sentAt.getTime();
  if (age > IMAP_CONFIRM_WINDOW_MS) {
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: {
        status: "unconfirmed",
        lastError: "Not found in the receiving mailbox within the confirmation window. Not marked as delivered.",
        leaseExpiresAt: null,
      },
    });
    await recordEvent(job.userId, job.mailboxId, "imap_unconfirmed", "No delivery confirmation within window", job.id);
    return;
  }

  const receiver = await prisma.smtpAccount.findUnique({ where: { id: job.receiverSmtpAccountId } });
  const m = await prisma.warmupMailboxSettings.findUnique({ where: { id: job.mailboxId } });
  if (!receiver || !m) return;

  const cfg = imapConfigFor(receiver);
  if (!cfg) {
    // No IMAP configured: we cannot verify. Say so plainly rather than
    // guessing. This is NOT a failure of the send.
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: {
        status: "unconfirmed",
        lastError: "Receiving mailbox has no IMAP configured, so delivery cannot be confirmed.",
        leaseExpiresAt: null,
      },
    });
    await recordEvent(job.userId, m.id, "imap_unconfirmed", "Receiver has no IMAP configuration", job.id);
    return;
  }

  // Only one worker may confirm a given job.
  //
  // The guard has to be on something that ACTUALLY CHANGES, or it guards
  // nothing. This previously read `where: { status: "sent" }` and wrote
  // `status: "sent"` -- a no-op -- so both workers in an overlapping tick
  // matched, both connected to IMAP, and both bumped `delivered`, double-counting
  // a delivery that happened once. It passed almost every run, which is what
  // made it worth chasing rather than shrugging at.
  //
  // Claiming by TAKING THE LEASE is the same mechanism `claimJob` uses, and it
  // is genuinely exclusive: a successful send leaves `leaseExpiresAt` null, the
  // winner sets it, and the loser no longer matches. `reclaimStaleJobs` releases
  // it again if the winner dies mid-check, so nothing is stranded.
  const locked = await prisma.warmupJob.updateMany({
    where: { id: job.id, status: "sent", leaseExpiresAt: null },
    data: { leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS) },
  });
  if (locked.count !== 1) return;

  // Hold the lease across the IMAP round-trip, but GIVE IT BACK on failure.
  //
  // Holding it is what makes the claim exclusive. Never releasing it would be a
  // self-inflicted outage: an IMAP socket timeout is the single most likely
  // failure here, and leaving the lease set would block every retry until it
  // expired -- silently stopping delivery confirmation for minutes after a
  // momentary blip. The job stays `sent` either way; only the lock is temporary.
  let result: Awaited<ReturnType<typeof confirmDelivery>>;
  try {
    result = await confirmDelivery({
      config: cfg,
      messageId: job.messageId,
      jobId: job.id,
      sentAt: job.sentAt,
    });
  } catch (err) {
    await prisma.warmupJob.updateMany({
      where: { id: job.id, status: "sent" },
      data: { leaseExpiresAt: null },
    });
    throw err;
  }

  if (result.confirmed) {
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: {
        status: "delivered",
        deliveredAt: new Date(),
        deliveryLatencyMs: result.latencyMs,
        receiverMessageId: result.receiverMessageId,
        leaseExpiresAt: null,
      },
    });
    await recordEvent(job.userId, m.id, "delivered", "Confirmed in receiving mailbox via IMAP", job.id, {
      latencyMs: result.latencyMs,
    });
    await bumpWarmupUsage(m.userId, m.id, { delivered: 1 });
  } else {
    // Stay in `sent` so the next tick retries until the window expires.
    await prisma.warmupJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: null, lastError: result.message.slice(0, 300) },
    });
  }
}

/** One pass over every enrolled mailbox. Exported for tests and diagnostics. */
export async function warmupTick(now: Date = new Date()): Promise<{ scheduled: number; sent: number; confirmed: number }> {
  let scheduled = 0;
  let sent = 0;
  let confirmed = 0;

  await reclaimStaleJobs();

  // 1. Schedule new work for every running mailbox that is inside its window.
  const mailboxes = await prisma.warmupMailboxSettings.findMany({
    where: { enabled: true, status: "running" },
    include: { smtpAccount: { select: { email: true, status: true } } },
  });

  let cursor = 0;
  for (const m of mailboxes) {
    if (!isWithinWindow(now, m.warmupWindowStart, m.warmupWindowEnd)) continue;
    if (m.smtpAccount.status !== "connected") continue;
    const plan = await planNextSend({ userId: m.userId, mailboxSettingsId: m.id, now, cursor: cursor++ });
    if (plan.action === "schedule") scheduled++;
  }

  // 2. Send anything that is due.
  const due = await prisma.warmupJob.findMany({
    where: { status: "queued", scheduledFor: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { scheduledFor: "asc" },
    take: 25,
  });
  for (const job of due) {
    if (await claimJob(job.id)) {
      await sendOne(job as DueJob);
      sent++;
    }
  }

  // 3. Confirm delivery for recently sent jobs.
  const toConfirm = await prisma.warmupJob.findMany({
    where: { status: "sent", sentAt: { not: null } },
    orderBy: { sentAt: "asc" },
    take: 25,
  });
  for (const job of toConfirm) {
    const m = await prisma.warmupMailboxSettings.findUnique({ where: { id: job.mailboxId }, select: { userId: true } });
    if (!m) continue;
    await confirmOne({ ...(job as DueJob), userId: m.userId });
    confirmed++;
  }

  return { scheduled, sent, confirmed };
}

export async function runWarmupWorker(): Promise<never> {
  console.log(`[warmup] starting — polling every ${TICK_MS / 1000}s`);
  // Never send anything unless at least one mailbox is explicitly enabled.
  for (;;) {
    try {
      const r = await warmupTick();
      if (r.scheduled || r.sent || r.confirmed) {
        console.log(`[warmup] scheduled=${r.scheduled} sent=${r.sent} confirmed=${r.confirmed}`);
      }
    } catch (err) {
      console.error("[warmup] tick failed", err);
    }
    await new Promise((res) => setTimeout(res, TICK_MS));
  }
}