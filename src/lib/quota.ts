import { prisma } from "@/lib/prisma";

export type SendProvider = "google" | "microsoft" | "smtp";

/** UTC calendar-day key, e.g. `2026-08-21`. */
export function dailyKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export const remainingBudget = (sent: number, dailyLimit: number): number =>
  Math.max(0, dailyLimit - sent);

export const isWithinDailyBudget = (sent: number, dailyLimit: number): boolean =>
  sent < dailyLimit;

export interface DailyUsage {
  date: string;
  messagesSent: number;
  messagesFailed: number;
  messagesSkipped: number;
  remaining: number;
  dailyLimit: number;
  exhausted: boolean;
}

/** Upserts and returns today's counter row for an account. */
export async function getDailyCounter(
  provider: SendProvider,
  accountId: string,
  userId: string,
  date: string = dailyKey(),
): Promise<{
  messagesSent: number;
  messagesFailed: number;
  messagesSkipped: number;
}> {
  const row = await prisma.dailySendCounter.upsert({
    where: { provider_accountId_date: { provider, accountId, date } },
    update: {},
    create: { provider, accountId, userId, date },
  });
  return {
    messagesSent: row.messagesSent,
    messagesFailed: row.messagesFailed,
    messagesSkipped: row.messagesSkipped,
  };
}

export type CounterIncrement =
  | { kind: "sent"; count: number }
  | { kind: "failed"; count: number }
  | { kind: "skipped"; count: number };

/** Increments today's counters atomically (`sent` is bumped only post-acceptance). */
export async function incrementDailyCounter(
  provider: SendProvider,
  accountId: string,
  userId: string,
  inc: CounterIncrement,
  date: string = dailyKey(),
): Promise<void> {
  const field = inc.kind === "sent" ? "messagesSent" : inc.kind === "failed" ? "messagesFailed" : "messagesSkipped";
  await prisma.dailySendCounter.upsert({
    where: { provider_accountId_date: { provider, accountId, date } },
    update: { [field]: { increment: inc.count } },
    create: {
      provider,
      accountId,
      userId,
      date,
      [field]: inc.count,
    },
  });
}

/**
 * Records a provider rate-limit hit on the account. The account is marked
 * paused-until after `threshold` consecutive hits, capped at maxDelaySeconds.
 * Returns the effective pause duration in ms (0 = not paused).
 */
export async function recordRateLimitHit(
  provider: SendProvider,
  accountId: string,
  hitDelaySeconds: number,
  message: string,
  now: Date = new Date(),
): Promise<number> {
  // SMTP accounts have no persisted quota-backoff columns; the in-tick backoff
  // on the recipient row is still applied by the worker.
  if (provider === "smtp") return 0;

  const account =
    provider === "google"
      ? await prisma.googleAccount.findUnique({ where: { id: accountId } })
      : await prisma.microsoftAccount.findUnique({ where: { id: accountId } });
  if (!account) return 0;

  const consecutive = account.consecutiveQuotaHits + 1;
  const pauseSeconds = consecutive >= 2 ? hitDelaySeconds : 0;
  const data = {
    consecutiveQuotaHits: consecutive,
    lastQuotaAt: now,
    quotaMessage: message,
    quotaPausedUntil: pauseSeconds > 0 ? new Date(now.getTime() + pauseSeconds * 1000) : null,
  };
  if (provider === "google") {
    await prisma.googleAccount.update({ where: { id: accountId }, data });
  } else {
    await prisma.microsoftAccount.update({ where: { id: accountId }, data });
  }
  return pauseSeconds * 1000;
}

/** Clears the account's persisted rate-limit state after a clean send. */
export async function clearRateLimitState(provider: SendProvider, accountId: string): Promise<void> {
  if (provider === "smtp") return; // SMTP accounts have no persisted quota state
  const data = { consecutiveQuotaHits: 0, quotaPausedUntil: null };
  if (provider === "google") {
    await prisma.googleAccount.updateMany({ where: { id: accountId }, data });
  } else {
    await prisma.microsoftAccount.updateMany({ where: { id: accountId }, data });
  }
}

/** True when the account is currently in a rate-limit backoff window. */
export const isQuotaPaused = (quotaPausedUntil: Date | null, now: Date = new Date()): boolean =>
  quotaPausedUntil !== null && quotaPausedUntil.getTime() > now.getTime();