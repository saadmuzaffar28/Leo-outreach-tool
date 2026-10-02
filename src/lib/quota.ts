import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type SendProvider = "google" | "microsoft" | "smtp";

/**
 * Primary key for a hand-written counter row.
 *
 * The column is `String @id @default(cuid())`, but that default is applied by
 * the Prisma CLIENT, not the database -- so raw SQL has to supply its own id.
 * The column is TEXT and only ever used as an opaque key, so a UUID is fine.
 */
const counterId = (): string => randomUUID();

/** UTC calendar-day key, e.g. `2026-08-21`. */
export function dailyKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export const remainingBudget = (sent: number, dailyLimit: number): number =>
  Math.max(0, dailyLimit - sent);

export const isWithinDailyBudget = (sent: number, dailyLimit: number): boolean =>
  sent < dailyLimit;

/**
 * Ensures today's counter row exists, without touching its totals.
 *
 * WHY RAW SQL: `prisma.dailySendCounter.upsert()` compiles to
 * SELECT-then-INSERT/UPDATE rather than a single statement. Two callers racing
 * on a not-yet-existing row both SELECT, both see nothing, and both INSERT --
 * which raises a unique-constraint violation (P2002) instead of succeeding. That
 * is a real crash under concurrent workers, not a theoretical one.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` is race-tolerant by construction: at most
 * one writer creates the row and every other writer is silently a no-op.
 */
async function ensureCounterRow(
  provider: SendProvider,
  accountId: string,
  userId: string,
  date: string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "DailySendCounter"
      ("id", "userId", "provider", "accountId", "date",
       "messagesSent", "messagesFailed", "messagesSkipped", "updatedAt")
    VALUES (${counterId()}, ${userId}, ${provider}, ${accountId}, ${date}, 0, 0, 0, NOW())
    ON CONFLICT ("provider", "accountId", "date") DO NOTHING
  `;
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
  await ensureCounterRow(provider, accountId, userId, date);
  const row = await prisma.dailySendCounter.findUniqueOrThrow({
    where: { provider_accountId_date: { provider, accountId, date } },
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

/**
 * Increments today's counters atomically (`sent` is bumped only post-acceptance).
 *
 * Same race as {@link getDailyCounter} -- `upsert` could raise P2002 when two
 * workers touched a brand-new row at once -- fixed the same way, with a single
 * statement that either inserts the row seeded with the count or adds to the
 * existing one. The insert and the increment can no longer come apart.
 *
 * The three variants are written out rather than built from a dynamic column
 * name because Prisma's tagged templates parameterise every interpolated value,
 * and a column name cannot be a bind parameter. Writing them out also keeps the
 * set of mutable columns closed by inspection: exactly these three, nothing else.
 */
export async function incrementDailyCounter(
  provider: SendProvider,
  accountId: string,
  userId: string,
  inc: CounterIncrement,
  date: string = dailyKey(),
): Promise<void> {
  const id = counterId();
  const n = inc.count;

  if (inc.kind === "sent") {
    await prisma.$executeRaw`
      INSERT INTO "DailySendCounter"
        ("id", "userId", "provider", "accountId", "date",
         "messagesSent", "messagesFailed", "messagesSkipped", "updatedAt")
      VALUES (${id}, ${userId}, ${provider}, ${accountId}, ${date}, ${n}, 0, 0, NOW())
      ON CONFLICT ("provider", "accountId", "date") DO UPDATE
        SET "messagesSent" = "DailySendCounter"."messagesSent" + ${n},
            "updatedAt" = NOW()
    `;
    return;
  }

  if (inc.kind === "failed") {
    await prisma.$executeRaw`
      INSERT INTO "DailySendCounter"
        ("id", "userId", "provider", "accountId", "date",
         "messagesSent", "messagesFailed", "messagesSkipped", "updatedAt")
      VALUES (${id}, ${userId}, ${provider}, ${accountId}, ${date}, 0, ${n}, 0, NOW())
      ON CONFLICT ("provider", "accountId", "date") DO UPDATE
        SET "messagesFailed" = "DailySendCounter"."messagesFailed" + ${n},
            "updatedAt" = NOW()
    `;
    return;
  }

  await prisma.$executeRaw`
    INSERT INTO "DailySendCounter"
      ("id", "userId", "provider", "accountId", "date",
       "messagesSent", "messagesFailed", "messagesSkipped", "updatedAt")
    VALUES (${id}, ${userId}, ${provider}, ${accountId}, ${date}, 0, 0, ${n}, NOW())
    ON CONFLICT ("provider", "accountId", "date") DO UPDATE
      SET "messagesSkipped" = "DailySendCounter"."messagesSkipped" + ${n},
          "updatedAt" = NOW()
  `;
}

/**
 * Atomically RESERVE one send slot against the shared per-mailbox daily budget.
 *
 * This is the single mechanism that keeps campaign sends and warm-up sends from
 * collectively exceeding `dailySendLimit`. Both systems count against the same
 * DailySendCounter row, so a limit of 20 with 8 warm-up sends leaves exactly 12
 * for campaigns -- and never 20 + 20.
 *
 * WHY THIS EXISTS: the previous approach in the campaign worker was
 * "read the counter, compare to the limit, then send, then increment". Two
 * concurrent workers could both read 19, both see 19 < 20, and both send,
 * producing 21. This function closes that window with a single conditional
 * UPDATE inside a transaction: the increment only lands if the row is still
 * below the ceiling at the moment of the write.
 *
 * Returns true if a slot was reserved (the caller must then either send or
 * release it), false if the budget was already exhausted.
 *
 * Callers MUST release the reservation on a failed send via
 * {@link releaseDailySlot}, otherwise a transient failure would permanently
 * consume budget for the day.
 */
export async function reserveDailySlot(
  provider: SendProvider,
  accountId: string,
  userId: string,
  dailyLimit: number,
  date: string = dailyKey(),
): Promise<boolean> {
  // A mailbox configured to send nothing can never be granted a slot. Checked
  // up front because the INSERT branch below has no ceiling predicate to fail:
  // it would happily create a row and return true for a limit of 0.
  if (!Number.isFinite(dailyLimit) || dailyLimit < 1) return false;

  // ONE statement does all of it: create the row if absent, otherwise claim a
  // slot on it -- and only while it is still under the ceiling.
  //
  // The ceiling check lives in the ON CONFLICT DO UPDATE ... WHERE clause. When
  // that predicate is false Postgres locks the conflicting row, re-reads it
  // under READ COMMITTED, declines to update, and returns no rows. That
  // re-read-after-lock is what makes concurrent reservations serialise instead
  // of racing: two callers cannot both observe the same "19 < 20" because the
  // second one is evaluated against the row the first one just bumped to 20.
  //
  // THE INSERT BRANCH SEEDS 1, NOT 0. The fresh-row path cannot consult a
  // WHERE clause, so it must consume the slot it is taking; seeding 0 handed
  // out one free send per mailbox per day and let a limit of 10 reach 11.
  //
  // This deliberately replaces an earlier two-step version (upsert the row,
  // then a conditional updateMany in a transaction). Besides leaking a
  // P2002 crash when the row did not yet exist, it held a transaction open
  // across two round trips for every single send.
  const claimed = await prisma.$queryRaw<Array<{ messagesSent: number }>>`
    INSERT INTO "DailySendCounter"
      ("id", "userId", "provider", "accountId", "date",
       "messagesSent", "messagesFailed", "messagesSkipped", "updatedAt")
    VALUES (${counterId()}, ${userId}, ${provider}, ${accountId}, ${date}, 1, 0, 0, NOW())
    ON CONFLICT ("provider", "accountId", "date") DO UPDATE
      SET "messagesSent" = "DailySendCounter"."messagesSent" + 1,
          "updatedAt" = NOW()
      WHERE "DailySendCounter"."messagesSent" < ${dailyLimit}
    RETURNING "messagesSent"
  `;
  return claimed.length > 0;
}

/**
 * Give back a reserved slot when the send did not happen.
 *
 * Only decrements when it will not go below zero, so a double release cannot
 * manufacture extra budget.
 */
export async function releaseDailySlot(
  provider: SendProvider,
  accountId: string,
  date: string = dailyKey(),
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "DailySendCounter"
       SET "messagesSent" = GREATEST(0, "messagesSent" - 1)
     WHERE "provider" = ${provider}
       AND "accountId" = ${accountId}
       AND "date" = ${date}
  `;
}

/**
 * Reads the remaining SHARED budget for a mailbox today: campaign sends AND
 * warm-up sends together, capped by the same `dailySendLimit`.
 */
export async function sharedBudgetLeft(
  provider: SendProvider,
  accountId: string,
  userId: string,
  dailyLimit: number,
  date: string = dailyKey(),
): Promise<number> {
  const c = await getDailyCounter(provider, accountId, userId, date);
  return remainingBudget(c.messagesSent, dailyLimit);
}

/**
 * Records a provider rate-limit hit on the account. The account is marked
 * paused-until after `threshold` consecutive hits, capped by maxDelaySeconds.
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