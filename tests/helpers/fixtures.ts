/**
 * Seed helpers for warm-up integration tests.
 *
 * The Prisma schema has real foreign keys (DailySendCounter -> User,
 * WarmupJob -> SmtpAccount, WarmupDailyUsage -> WarmupMailboxSettings), so
 * tests must build a valid object graph rather than inventing ids. This module
 * creates that graph against the throwaway test database.
 */

import type { PrismaClient } from "@prisma/client";
import { encrypt } from "@/lib/encryption";

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createUser(prisma: PrismaClient, email?: string) {
  const address = email ?? `${uniq("user")}@test.example`;
  return prisma.user.create({
    data: { email: address, name: address, passwordHash: "not-a-real-hash" },
  });
}

/** An SMTP mailbox with encrypted credentials. The password is never returned. */
export async function createSmtpAccount(
  prisma: PrismaClient,
  userId: string,
  opts: { email?: string; status?: string; imapHost?: string | null } = {},
) {
  const email = opts.email ?? `${uniq("mbox")}@test.example`;
  return prisma.smtpAccount.create({
    data: {
      userId,
      email,
      host: "smtp.test.example",
      port: 587,
      security: "starttls",
      usernameEncrypted: encrypt(`${email}-user`),
      passwordEncrypted: encrypt("super-secret-password"),
      status: opts.status ?? "connected",
      imapHost: opts.imapHost === undefined ? "imap.test.example" : opts.imapHost,
      imapPort: 993,
      imapSecurity: "ssl",
      imapStatus: opts.imapHost === null ? "unconfigured" : "connected",
    },
  });
}

/** Enrol a mailbox in warm-up. `enabled` defaults to false, as in production. */
export async function enrollMailbox(
  prisma: PrismaClient,
  userId: string,
  smtpAccountId: string,
  opts: Partial<{
    enabled: boolean;
    status: string;
    startingDailyVolume: number;
    maximumDailyVolume: number;
    dailyIncrease: number;
    minimumDelaySeconds: number;
    maximumDelaySeconds: number;
    warmupWindowStart: string;
    warmupWindowEnd: string;
    pauseOnError: boolean;
    maxConsecutiveFailures: number;
    currentDay: number;
    consecutiveFailures: number;
    lastActiveDate: string | null;
  }> = {},
) {
  return prisma.warmupMailboxSettings.create({
    data: {
      userId,
      smtpAccountId,
      enabled: opts.enabled ?? false,
      status: opts.status ?? (opts.enabled ? "running" : "paused"),
      startingDailyVolume: opts.startingDailyVolume ?? 5,
      maximumDailyVolume: opts.maximumDailyVolume ?? 15,
      dailyIncrease: opts.dailyIncrease ?? 1,
      minimumDelaySeconds: opts.minimumDelaySeconds ?? 0,
      maximumDelaySeconds: opts.maximumDelaySeconds ?? 0,
      warmupWindowStart: opts.warmupWindowStart ?? "00:00",
      warmupWindowEnd: opts.warmupWindowEnd ?? "23:59",
      pauseOnError: opts.pauseOnError ?? true,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
      currentDay: opts.currentDay ?? 0,
      consecutiveFailures: opts.consecutiveFailures ?? 0,
      lastActiveDate: opts.lastActiveDate ?? null,
    },
  });
}

/**
 * SendSettings row with a known daily limit, so the ceiling is deterministic.
 *
 * `warmupEnabled` defaults to TRUE here because creating a running, enabled
 * `warmupMailboxSettings` row IS an explicit opt-in to warm-up. Leaving it at
 * the product default (false) would make every warm-up test assert on the master
 * switch instead of the behaviour it is actually about. Tests that care about
 * the switch itself pass `false` and have their own dedicated coverage.
 */
export async function setDailyLimit(
  prisma: PrismaClient,
  userId: string,
  limit: number,
  warmupEnabled = true,
) {
  return prisma.sendSettings.upsert({
    where: { userId },
    update: { dailySendLimit: limit, warmupEnabled },
    create: { userId, dailySendLimit: limit, warmupEnabled },
  });
}