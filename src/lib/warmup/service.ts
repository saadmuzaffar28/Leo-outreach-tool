import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getSendSettings } from "@/lib/settings";
import { dailyKey, sharedBudgetLeft, reserveDailySlot, releaseDailySlot } from "@/lib/quota";
import { targetForDay, nextRampDay, warmupAllowance } from "@/lib/warmup/ramp";
import { pickReceiverPreferCrossDomain, type PoolMember } from "@/lib/warmup/pool";
import { buildWarmupContent, buildWarmupMessageId, buildWarmupHeaders, warmupNonce } from "@/lib/warmup/messages";

/**
 * Warm-up orchestration service.
 *
 * Responsibilities kept deliberately narrow: resolve enrolled mailboxes, work
 * out how much of the SHARED daily budget warm-up may still use, create jobs,
 * and record usage. It performs no SMTP or IMAP work itself -- that lives in
 * the worker so the service stays testable and side-effect free.
 */

export type { WarmupMailboxStatus, WarmupMailboxView } from "@/lib/warmup/types";
import type { WarmupMailboxStatus, WarmupMailboxView } from "@/lib/warmup/types";

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** The enrolled, enabled pool for a user -- the only possible recipients. */
export async function loadPool(userId: string): Promise<PoolMember[]> {
  const rows = await prisma.warmupMailboxSettings.findMany({
    where: { userId, enabled: true },
    select: { smtpAccount: { select: { id: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .map((r) => ({ id: r.smtpAccount.id, email: r.smtpAccount.email }))
    .filter((m): m is PoolMember => Boolean(m));
}

/**
 * Every SMTP mailbox the user owns, merged with its warm-up settings.
 * Mailboxes with no settings row are shown as "not enrolled" rather than being
 * hidden, so the operator can see everything available to enrol.
 */
export async function listWarmupMailboxes(userId: string): Promise<WarmupMailboxView[]> {
  const [accounts, settings, sendSettings] = await Promise.all([
    prisma.smtpAccount.findMany({
      where: { userId },
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        host: true,
        port: true,
        security: true,
        status: true,
        imapHost: true,
        imapStatus: true,
        imapLastTestedAt: true,
        imapLastTestError: true,
      },
    }),
    prisma.warmupMailboxSettings.findMany({
      where: { userId },
      include: { smtpAccount: { select: { id: true, email: true } } },
    }),
    getSendSettings(userId),
  ]);

  const bySmtpId = new Map(settings.map((s) => [s.smtpAccountId, s]));
  const today = dailyKey();

  const usageRows = await prisma.warmupDailyUsage.findMany({
    where: { userId, date: today },
    select: { mailboxId: true, warmupSent: true, delivered: true, warmupFailed: true },
  });
  const usageByMailbox = new Map(usageRows.map((u) => [u.mailboxId, u]));

  const out: WarmupMailboxView[] = [];
  for (const a of accounts) {
    const s = bySmtpId.get(a.id) ?? null;
    const usage = s ? usageByMailbox.get(s.id) : undefined;

    // Shared budget for this mailbox today, counting campaign AND warm-up.
    const budgetLeft = await sharedBudgetLeft(
      "smtp",
      a.id,
      userId,
      sendSettings.dailySendLimit,
      today,
    );

    const cfg = {
      startingDailyVolume: s?.startingDailyVolume ?? sendSettings.warmupStartingDailyVolume,
      dailyIncrease: s?.dailyIncrease ?? sendSettings.warmupDailyIncrease,
      maximumDailyVolume: s?.maximumDailyVolume ?? sendSettings.warmupMaximumDailyVolume,
    };
    const day = s?.currentDay ?? 0;
    const target = s ? targetForDay(day, cfg) : 0;
    const todaySent = usage?.warmupSent ?? 0;

    out.push({
      smtpAccountId: a.id,
      settingsId: s?.id ?? null,
      email: a.email,
      domain: domainOf(a.email),
      connectionType: "smtp",
      host: a.host,
      port: a.port,
      security: a.security,
      connectionStatus: a.status,
      imapConfigured: Boolean(a.imapHost),
      imapStatus: a.imapStatus,
      imapLastTestedAt: a.imapLastTestedAt,
      imapLastTestError: a.imapLastTestError,

      enrolled: Boolean(s),
      enabled: s?.enabled ?? false,
      status: (s?.status as WarmupMailboxStatus) ?? "paused",
      statusMessage: s?.statusMessage ?? null,
      currentDay: day,
      startingDailyVolume: cfg.startingDailyVolume,
      maximumDailyVolume: cfg.maximumDailyVolume,
      dailyIncrease: cfg.dailyIncrease,
      minimumDelaySeconds: s?.minimumDelaySeconds ?? sendSettings.warmupMinDelaySeconds,
      maximumDelaySeconds: s?.maximumDelaySeconds ?? sendSettings.warmupMaxDelaySeconds,
      warmupWindowStart: s?.warmupWindowStart ?? "09:00",
      warmupWindowEnd: s?.warmupWindowEnd ?? "17:00",
      pauseOnError: s?.pauseOnError ?? true,
      maxConsecutiveFailures: s?.maxConsecutiveFailures ?? 3,

      dailyTarget: target,
      todaySent,
      todayDelivered: usage?.delivered ?? 0,
      sharedBudgetLeft: budgetLeft,
      warmupAllowance: warmupAllowance(budgetLeft, todaySent, target),
      todayFailed: usage?.warmupFailed ?? 0,

      lastSendAt: s?.lastSendAt ?? null,
      lastActiveDate: s?.lastActiveDate ?? null,
      consecutiveSuccessfulDays: s?.consecutiveSuccessfulDays ?? 0,
      consecutiveFailures: s?.consecutiveFailures ?? 0,
      startedAt: s?.startedAt ?? null,
    });
  }
  return out;
}

/** Ensure a settings row exists for a mailbox, seeded from global defaults. */
export async function ensureWarmupSettings(userId: string, smtpAccountId: string) {
  const existing = await prisma.warmupMailboxSettings.findUnique({ where: { smtpAccountId } });
  if (existing) return existing;

  const s = await getSendSettings(userId);
  try {
    // create, not upsert: two concurrent callers (two browser tabs, or a UI
    // start racing the worker's tick) both read "not enrolled" and then both
    // insert. `upsert` would make one of them crash with P2002 rather than
    // simply returning the row the other one created.
    return await prisma.warmupMailboxSettings.create({
      data: {
        userId,
        smtpAccountId,
        enabled: false,
        startingDailyVolume: s.warmupStartingDailyVolume,
        maximumDailyVolume: s.warmupMaximumDailyVolume,
        dailyIncrease: s.warmupDailyIncrease,
        minimumDelaySeconds: s.warmupMinDelaySeconds,
        maximumDelaySeconds: s.warmupMaxDelaySeconds,
        status: "paused",
      },
    });
  } catch (err) {
    // Someone else won the race; their row is equally valid.
    // Duck-typed on `code` rather than importing Prisma's error class from its
    // runtime internals, which is not a stable public entry point.
    if (isUniqueConstraintViolation(err)) {
      const raced = await prisma.warmupMailboxSettings.findUnique({ where: { smtpAccountId } });
      if (raced) return raced;
    }
    throw err;
  }
}

/** True for Prisma's P2002 (unique constraint violated). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Record today's warm-up usage row. This is a BREAKDOWN for charts only -- the
 * absolute ceiling remains DailySendCounter.
 */
export async function recordWarmupUsage(
  userId: string,
  mailboxId: string,
  patch: { warmupSent?: number; warmupFailed?: number; delivered?: number; target?: number; rampDay?: number },
  date: string = dailyKey(),
): Promise<void> {
  // Two statements rather than `upsert`, for the same reason as
  // ensureCounterRow in quota.ts: Prisma's upsert is SELECT-then-INSERT, so two
  // workers opening the same mailbox's first usage row of the day would both
  // try to INSERT and one would crash with P2002. `ON CONFLICT DO NOTHING`
  // cannot fail, and the follow-up write lands on the row that now exists.
  //
  // This SETS absolute values, it does not increment -- see bumpWarmupUsage.
  await prisma.$executeRaw`
    INSERT INTO "WarmupDailyUsage"
      ("id", "userId", "mailboxId", "date",
       "warmupSent", "warmupFailed", "delivered", "target", "rampDay",
       "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, ${mailboxId}, ${date},
            ${patch.warmupSent ?? 0}, ${patch.warmupFailed ?? 0}, ${patch.delivered ?? 0},
            ${patch.target ?? 0}, ${patch.rampDay ?? 0}, NOW(), NOW())
    ON CONFLICT ("mailboxId", "date") DO NOTHING
  `;
  await prisma.warmupDailyUsage.update({
    where: { mailboxId_date: { mailboxId, date } },
    data: patch,
  });
}

/**
 * Atomically BUMP warm-up usage counters.
 *
 * Separate from {@link recordWarmupUsage} (which SETS values) because counters
 * must be incremented in the database, not read-modify-written in JS -- two
 * workers finishing sends at the same time would otherwise lose one count.
 *
 * One statement. As in reserveDailySlot, the INSERT branch has to carry the
 * increment itself, since there is no WHERE clause to fall through to when the
 * row is brand new -- seeding zeros there silently dropped the day's first
 * send.
 */
export async function bumpWarmupUsage(
  userId: string,
  mailboxId: string,
  patch: { warmupSent?: number; warmupFailed?: number; delivered?: number },
  date: string = dailyKey(),
): Promise<void> {
  const sent = patch.warmupSent ?? 0;
  const failed = patch.warmupFailed ?? 0;
  const delivered = patch.delivered ?? 0;
  if (sent + failed + delivered === 0) return;

  await prisma.$executeRaw`
    INSERT INTO "WarmupDailyUsage"
      ("id", "userId", "mailboxId", "date",
       "warmupSent", "warmupFailed", "delivered", "target", "rampDay",
       "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, ${mailboxId}, ${date},
            ${sent}, ${failed}, ${delivered}, 0, 0, NOW(), NOW())
    ON CONFLICT ("mailboxId", "date") DO UPDATE
      SET "warmupSent"   = "WarmupDailyUsage"."warmupSent" + ${sent},
          "warmupFailed" = "WarmupDailyUsage"."warmupFailed" + ${failed},
          "delivered"    = "WarmupDailyUsage"."delivered" + ${delivered},
          "updatedAt"    = NOW()
  `;
}

/** Append to the audit trail. `meta` must never contain credentials. */
export async function recordEvent(
  userId: string,
  mailboxId: string,
  type: string,
  message?: string,
  jobId?: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await prisma.warmupEvent.create({
    data: {
      userId,
      mailboxId,
      jobId: jobId ?? null,
      type,
      message: message ?? null,
      meta: meta ? (meta as object) : undefined,
    },
  });
}

export interface PlanNextSendResult {
  action: "schedule" | "wait" | "stop";
  reason: string;
  job?: {
    id: string;
    messageId: string;
    receiverEmail: string;
    scheduledFor: Date;
  };
}

/**
 * Decide whether one more warm-up send may be scheduled right now, and create
 * the job if so.
 *
 * Every safety gate is checked here, before anything is sent:
 *   - the mailbox must be enrolled, enabled and running
 *   - the ramp target for today must not already be met
 *   - the warm-up WINDOW must be open
 *   - the SHARED daily budget must have room (campaign + warm-up)
 *   - the receiver must be another ENROLLED pool mailbox
 *   - the shared budget slot is RESERVED atomically, so two workers cannot
 *     together overshoot the daily ceiling
 *
 * `cursor` rotates the receiver so the same pair is not always used.
 */
export async function planNextSend(opts: {
  userId: string;
  mailboxSettingsId: string;
  now?: Date;
  cursor?: number;
}): Promise<PlanNextSendResult> {
  const now = opts.now ?? new Date();
  const today = dailyKey(now);

  const m = await prisma.warmupMailboxSettings.findUnique({
    where: { id: opts.mailboxSettingsId },
    include: { smtpAccount: true },
  });
  if (!m || m.userId !== opts.userId) return { action: "stop", reason: "Mailbox not found" };

  // A paused_error mailbox needs a MANUAL resume; nothing here clears it.
  if (!m.enabled || m.status !== "running") {
    return { action: "stop", reason: `Mailbox warm-up is ${m.status}` };
  }
  // Respect disabled/broken SMTP connection state.
  if (m.smtpAccount.status !== "connected") {
    return { action: "wait", reason: `SMTP account is ${m.smtpAccount.status}` };
  }

  const sendSettings = await getSendSettings(opts.userId);

  // The user-level master switch. `warmupEnabled` is surfaced in the dashboard
  // and in GET/PUT /api/warmup/settings, so an operator who turns it off must
  // actually stop the warm-up -- not merely see a toggle move.
  //
  // It was previously read by nothing at all: the only enforced gate was the
  // per-mailbox `enabled` flag, which meant the switch lied. That is the
  // dangerous direction of this particular bug -- "I turned it off" would not
  // have stopped anything.
  if (!sendSettings.warmupEnabled) {
    return { action: "stop", reason: "Mailbox warm-up is switched off in settings" };
  }

  const cfg = {
    startingDailyVolume: m.startingDailyVolume,
    dailyIncrease: m.dailyIncrease,
    maximumDailyVolume: m.maximumDailyVolume,
  };

  const alreadyRanToday = m.lastActiveDate === today;
  const day = nextRampDay(m.currentDay, alreadyRanToday);
  const target = targetForDay(day, cfg);

  // The ramp target is an UPPER BOUND on the day's warm-up volume, so it has to
  // count work that is already committed but not yet finished, not just work
  // that has completed.
  //
  // Counting `warmupSent` alone was wrong in a way that only shows up in
  // production. `warmupSent` is incremented when a message finishes sending, but
  // the worker calls this function once per 30s tick, and a freshly scheduled
  // job sits in `queued` for its jittered delay first. So the target read 0 for
  // every tick in that window and each one scheduled another message: a mailbox
  // with a target of 1/day sent 2, and with a longer delay it overshoots by one
  // more per tick. The live A->B test sent 4 messages where 2 were intended --
  // and each of those draws on the budget shared with real campaigns.
  //
  // Counting committed jobs closes the window: once a job exists for today, the
  // target is met and no further job is planned, regardless of whether it has
  // been sent yet.
  const dayStart = new Date(`${today}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const committedToday = await prisma.warmupJob.count({
    where: {
      mailboxId: m.id,
      scheduledFor: { gte: dayStart, lt: dayEnd },
    },
  });

  if (committedToday >= target) {
    return {
      action: "wait",
      reason: `Daily ramp target met (${committedToday}/${target})`,
    };
  }

  // Pool must contain at least one OTHER mailbox -- never an external recipient.
  const pool = await loadPool(opts.userId);
  const receiver = pickReceiverPreferCrossDomain(pool, { id: m.smtpAccountId, email: m.smtpAccount.email }, opts.cursor ?? 0);
  if (!receiver) {
    return {
      action: "stop",
      reason: "No other enrolled warm-up mailbox to receive from. Warm-up only ever sends between enrolled mailboxes.",
    };
  }

  const receiverAccount = await prisma.smtpAccount.findUnique({ where: { id: receiver.id } });
  if (!receiverAccount || receiverAccount.userId !== opts.userId) {
    return { action: "stop", reason: "Chosen receiver is not owned by this user" };
  }

  // Atomic reservation against the SHARED budget (campaign + warm-up).
  const reserved = await reserveDailySlot("smtp", m.smtpAccountId, opts.userId, sendSettings.dailySendLimit, today);
  if (!reserved) {
    return { action: "wait", reason: `Shared daily send limit reached (${sendSettings.dailySendLimit})` };
  }

  // Space the send out by a jittered delay so there is never a burst.
  const minD = m.minimumDelaySeconds;
  const maxD = Math.max(m.maximumDelaySeconds, m.minimumDelaySeconds);
  let delay = minD + Math.floor(Math.random() * (maxD - minD + 1));

  // A zero-width jitter window (or a paused-then-restarted mailbox that yields
  // two sends inside the same clock tick) can produce two jobs for one mailbox
  // with an identical scheduledFor, which violates
  // `@@unique([mailboxId, scheduledFor])` and crashes the insert. Nudge
  // forward until it is distinct rather than letting a collision take down the
  // tick. Millisecond granularity is far finer than any real delay, so this
  // never meaningfully changes send spacing.
  const distinct = async (candidate: Date): Promise<Date> => {
    for (let i = 0; i < 1000; i++) {
      const clash = await prisma.warmupJob.findFirst({
        where: { mailboxId: m.id, scheduledFor: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
      candidate = new Date(candidate.getTime() + 1);
    }
    // Pathological case: a thousand collisions. Fall back to "now", which the
    // caller has already proven is >= the previous job for this mailbox.
    return new Date();
  };
  let scheduledFor = await distinct(new Date(now.getTime() + delay * 1000));

  // The Message-ID embeds the job's primary key, so it is unique by
  // construction and can never collide with an existing row.
  const domain = domainOf(m.smtpAccount.email);

  // The check-then-insert above is still a race: two workers planning for the
  // same mailbox in the same tick can both see a free instant and both insert.
  // Retry on the unique violation, nudging forward, rather than letting one
  // worker's tick die with a P2002.
  let job: Awaited<ReturnType<typeof prisma.warmupJob.create>>;
  for (let attempt = 0; ; attempt++) {
    try {
      job = await prisma.warmupJob.create({
        data: {
          userId: opts.userId,
          mailboxId: m.id,
          senderSmtpAccountId: m.smtpAccountId,
          receiverSmtpAccountId: receiverAccount.id,
          // Provisional, immediately rewritten below. The UUID is unique.
          messageId: `provisional-${randomUUID()}@${domain}`,
          subject: "warm-up",
          status: "queued",
          scheduledFor,
        },
      });
      break;
    } catch (err) {
      if (!isUniqueConstraintViolation(err) || attempt >= 1000) throw err;
      scheduledFor = new Date(scheduledFor.getTime() + 1);
    }
  }

  // Now that a real cuid exists, embed it in the msg-id + subject.
  const finalMessageId = buildWarmupMessageId(job.id, domain);
  const finalContent = buildWarmupContent(Math.floor(Math.random() * 5), job.id);
  await prisma.warmupJob.update({
    where: { id: job.id },
    data: { messageId: finalMessageId, subject: finalContent.subject },
  });

  await recordEvent(opts.userId, m.id, "scheduled", `Queued warm-up send to ${receiverAccount.email}`, job.id, {
    day,
    target,
    scheduledFor: scheduledFor.toISOString(),
  });

  // Keep the ramp day / last-active bookkeeping in step.
  await prisma.warmupMailboxSettings.update({
    where: { id: m.id },
    data: {
      currentDay: day,
      lastActiveDate: today,
      lastSendAt: scheduledFor,
    },
  });
  await recordWarmupUsage(opts.userId, m.id, { target, rampDay: day }, today);

  return {
    action: "schedule",
    reason: "Scheduled",
    job: { id: job.id, messageId: finalMessageId, receiverEmail: receiverAccount.email, scheduledFor },
  };
}

/**
 * Release a reservation when a scheduled send is abandoned, so a transient
 * problem cannot permanently consume daily budget.
 */
export async function releaseSlotFor(smtpAccountId: string): Promise<void> {
  await releaseDailySlot("smtp", smtpAccountId);
}

/** Headers for the actual SMTP send, built from the stored job. */
export function headersForJob(job: { id: string; messageId: string; senderEmail: string; receiverEmail: string; subject: string }) {
  return buildWarmupHeaders({
    jobId: job.id,
    messageId: job.messageId,
    from: job.senderEmail,
    to: job.receiverEmail,
    subject: job.subject,
    nonce: warmupNonce(),
  });
}
// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

export interface ActionResult {
  ok: boolean;
  status: WarmupMailboxStatus;
  message: string;
}

/** Load a mailbox the caller owns, by its SmtpAccount id (the id the UI uses). */
export async function loadOwnedMailbox(userId: string, smtpAccountId: string) {
  return prisma.warmupMailboxSettings.findFirst({
    where: { userId, smtpAccountId },
  });
}

/**
 * Start (or resume) warm-up for a mailbox.
 *
 * Refuses to start when the sender has no partner, because warm-up only ever
 * sends BETWEEN enrolled mailboxes. Enabling a lone mailbox would leave jobs
 * permanently blocked, which looks like a silent failure to the operator.
 */
export async function startWarmup(userId: string, smtpAccountId: string): Promise<ActionResult> {
  const m = await ensureWarmupSettings(userId, smtpAccountId);
  if (m.userId !== userId) return { ok: false, status: "paused", message: "Not found" };

  const pool = await loadPool(userId);
  const partners = pool.filter((p) => p.id !== smtpAccountId).length;
  if (partners === 0) {
    await prisma.warmupMailboxSettings.update({
      where: { id: m.id },
      data: {
        status: "paused",
        statusMessage:
          "Cannot start: warm-up sends only between enrolled mailboxes. Enable at least one other mailbox first.",
      },
    });
    return {
      ok: false,
      status: "paused",
      message: "Enable at least one other enrolled mailbox first — warm-up never sends to an external address.",
    };
  }

  // A manual resume CLEARS the auto-pause reason and the failure counter. This
  // is the explicit "I fixed it" signal the requirement asks for.
  await prisma.warmupMailboxSettings.update({
    where: { id: m.id },
    data: {
      enabled: true,
      status: "running",
      statusMessage: null,
      consecutiveFailures: 0,
      startedAt: m.startedAt ?? new Date(),
    },
  });
  await recordEvent(userId, m.id, "resumed", "Warm-up started/resumed by operator");
  return { ok: true, status: "running", message: "Warm-up started" };
}

/** Pause warm-up. Operator-initiated pauses keep any auto-pause reason visible. */
export async function pauseWarmup(userId: string, smtpAccountId: string): Promise<ActionResult> {
  const m = await loadOwnedMailbox(userId, smtpAccountId);
  if (!m) return { ok: false, status: "paused", message: "Not found" };
  await prisma.warmupMailboxSettings.update({
    where: { id: m.id },
    data: { enabled: false, status: "paused", statusMessage: null },
  });
  await recordEvent(userId, m.id, "paused", "Warm-up paused by operator");
  return { ok: true, status: "paused", message: "Warm-up paused" };
}

/**
 * Reset the ramp back to day 1 and clear failure state.
 *
 * Jobs already queued are cancelled and their reserved shared-budget slots are
 * released, so a reset cannot leave budget stranded for the rest of the day.
 */
export async function resetWarmup(userId: string, smtpAccountId: string): Promise<ActionResult> {
  const m = await loadOwnedMailbox(userId, smtpAccountId);
  if (!m) return { ok: false, status: "paused", message: "Not found" };

  const pending = await prisma.warmupJob.findMany({
    where: { mailboxId: m.id, status: { in: ["queued", "sending"] } },
    select: { id: true, senderSmtpAccountId: true },
  });
  for (const j of pending) {
    await releaseSlotFor(j.senderSmtpAccountId);
  }
  await prisma.warmupJob.updateMany({
    where: { mailboxId: m.id, status: { in: ["queued", "sending"] } },
    data: { status: "cancelled", leaseExpiresAt: null, lastError: "Cancelled by ramp reset" },
  });

  await prisma.warmupMailboxSettings.update({
    where: { id: m.id },
    data: {
      currentDay: 0,
      lastActiveDate: null,
      consecutiveFailures: 0,
      consecutiveSuccessfulDays: 0,
      statusMessage: null,
      status: m.enabled ? "running" : "paused",
    },
  });
  await recordEvent(userId, m.id, "reset", `Ramp reset to day 1 (${pending.length} pending job(s) cancelled)`);
  return { ok: true, status: m.enabled ? "running" : "paused", message: "Ramp reset to day 1" };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface WarmupStats {
  totalSends: number;
  totalDelivered: number;
  totalFailed: number;
  totalUnconfirmed: number;
  smtpFailures: number;
  imapFailures: number;
  /** Median-ish summary of confirmed deliveries, in ms. */
  averageLatencyMs: number | null;
  consecutiveSuccessfulDays: number;
  consecutiveFailures: number;
  currentDay: number;
  dailyTarget: number;
  todaySent: number;
  todayDelivered: number;
  /** Chart series, oldest first. */
  daily: Array<{
    date: string;
    warmupSent: number;
    delivered: number;
    warmupFailed: number;
    target: number;
  }>;
}

/** Every date key from `days` ago through today, oldest first. */
function dateRange(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    out.push(dailyKey(d));
  }
  return out;
}

/**
 * Aggregate warm-up metrics. `days` controls both the chart window and the
 * totals, so the UI's 7-day and 30-day views are the same call with a different
 * number rather than two different code paths.
 */
export async function warmupStats(userId: string, days = 7, smtpAccountId?: string): Promise<WarmupStats> {
  const since = dailyKey(new Date(Date.now() - (days - 1) * 86_400_000));
  const today = dailyKey();

  const mailboxFilter = smtpAccountId ? { smtpAccountId } : {};
  const mailboxes = await prisma.warmupMailboxSettings.findMany({
    where: { userId, ...mailboxFilter },
    select: { id: true, currentDay: true, consecutiveSuccessfulDays: true, consecutiveFailures: true, startingDailyVolume: true, dailyIncrease: true, maximumDailyVolume: true },
  });
  const ids = mailboxes.map((m) => m.id);

  const usage = await prisma.warmupDailyUsage.findMany({
    where: { userId, date: { gte: since }, mailboxId: { in: ids } },
  });
  const byDate = new Map<string, { warmupSent: number; delivered: number; warmupFailed: number; target: number }>();
  for (const u of usage) {
    const cur = byDate.get(u.date) ?? { warmupSent: 0, delivered: 0, warmupFailed: 0, target: 0 };
    cur.warmupSent += u.warmupSent;
    cur.delivered += u.delivered;
    cur.warmupFailed += u.warmupFailed;
    cur.target = Math.max(cur.target, u.target);
    byDate.set(u.date, cur);
  }

  const jobs = await prisma.warmupJob.findMany({
    where: { userId, mailboxId: { in: ids }, createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    select: { status: true, failureKind: true, deliveryLatencyMs: true },
  });

  let smtpFailures = 0;
  let imapFailures = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let totalDelivered = 0;
  let totalUnconfirmed = 0;
  for (const j of jobs) {
    if (j.status === "delivered") {
      totalDelivered++;
      if (typeof j.deliveryLatencyMs === "number") {
        latencySum += j.deliveryLatencyMs;
        latencyCount++;
      }
    }
    if (j.status === "unconfirmed") totalUnconfirmed++;
    if (j.failureKind === "imap") imapFailures++;
    else if (j.failureKind && j.status === "failed") smtpFailures++;
  }

  const todayRow = byDate.get(today) ?? { warmupSent: 0, delivered: 0, warmupFailed: 0, target: 0 };

  return {
    totalSends: jobs.filter((j) => j.status === "sent" || j.status === "delivered").length,
    totalDelivered,
    totalFailed: jobs.filter((j) => j.status === "failed").length,
    totalUnconfirmed,
    smtpFailures,
    imapFailures,
    averageLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    consecutiveSuccessfulDays: mailboxes.reduce((a, m) => a + m.consecutiveSuccessfulDays, 0),
    consecutiveFailures: mailboxes.reduce((a, m) => a + m.consecutiveFailures, 0),
    currentDay: mailboxes.length > 0 ? Math.max(...mailboxes.map((m) => m.currentDay)) : 0,
    dailyTarget: todayRow.target,
    todaySent: todayRow.warmupSent,
    todayDelivered: todayRow.delivered,
    daily: dateRange(days).map((date) => ({
      date,
      warmupSent: byDate.get(date)?.warmupSent ?? 0,
      delivered: byDate.get(date)?.delivered ?? 0,
      warmupFailed: byDate.get(date)?.warmupFailed ?? 0,
      target: byDate.get(date)?.target ?? 0,
    })),
  };
}

/** Recent audit events for the dashboard feed. Never contains credentials. */
export async function warmupEvents(userId: string, opts: { limit: number; mailboxId?: string; type?: string }) {
  const rows = await prisma.warmupEvent.findMany({
    where: {
      userId,
      ...(opts.mailboxId ? { mailboxId: opts.mailboxId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit,
    select: {
      id: true,
      type: true,
      message: true,
      createdAt: true,
      mailboxId: true,
      jobId: true,
      meta: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    message: r.message,
    createdAt: r.createdAt,
    mailboxId: r.mailboxId,
    jobId: r.jobId,
    meta: (r.meta ?? null) as Record<string, unknown> | null,
  }));
}