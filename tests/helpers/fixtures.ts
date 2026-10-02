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

// ---------------------------------------------------------------------------
// Campaign fixtures
// ---------------------------------------------------------------------------

export async function createTemplate(
  prisma: PrismaClient,
  userId: string,
  opts: { name?: string; subject?: string; body?: string } = {},
) {
  return prisma.emailTemplate.create({
    data: {
      userId,
      name: opts.name ?? uniq("tpl"),
      subject: opts.subject ?? "Hello {{first_name}}",
      body: opts.body ?? "<p>Hi {{first_name}}, this is a test body.</p>",
    },
  });
}

export async function createLead(
  prisma: PrismaClient,
  userId: string,
  opts: { email?: string; firstName?: string; groupId?: string } = {},
) {
  const email = opts.email ?? `${uniq("lead")}@lead.example`;
  const lead = await prisma.lead.create({
    data: { userId, email, firstName: opts.firstName ?? "Test", lastName: "Lead" },
  });
  if (opts.groupId) {
    await prisma.leadGroup.create({ data: { groupId: opts.groupId, leadId: lead.id } });
  }
  return lead;
}

/**
 * SendSettings tuned so the worker will actually claim every row it selects:
 * no per-minute throttling and no minimum delay.
 *
 * The in-process `SendRateLimiter` is a module-level singleton that PERSISTS
 * across `processDueRecipients` calls within a test file, so a tick being
 * allowed to send is a precondition for asserting anything about which rows the
 * queue selected. These values make that precondition unconditional.
 */
export async function setPermissiveSendSettings(prisma: PrismaClient, userId: string, dailyLimit = 1000) {
  const values = {
    dailySendLimit: dailyLimit,
    messagesPerMinute: 600,
    minDelaySeconds: 0,
    maxRetryAttempts: 3,
    baseRetryDelaySeconds: 1,
    maxRetryDelaySeconds: 10,
    sendMode: "live",
  };
  return prisma.sendSettings.upsert({
    where: { userId },
    update: values,
    create: { userId, ...values },
  });
}

export async function createCampaign(
  prisma: PrismaClient,
  userId: string,
  opts: {
    name?: string;
    status?: string;
    templateId?: string;
    smtpAccountId?: string;
    groupId?: string;
  } = {},
) {
  return prisma.campaign.create({
    data: {
      userId,
      name: opts.name ?? uniq("campaign"),
      status: opts.status ?? "draft",
      templateId: opts.templateId,
      smtpAccountId: opts.smtpAccountId,
      recipientGroupId: opts.groupId,
    },
  });
}

/** Creates recipients and returns them ordered by id, so a test can assert positionally. */
export async function createRecipients(
  prisma: PrismaClient,
  campaignId: string,
  recipients: Array<{
    email: string;
    leadId?: string;
    status?: string;
    attempts?: number;
    createdAt?: Date;
    lastError?: string;
    nextAttemptAt?: Date | null;
  }>,
) {
  await prisma.campaignRecipient.createMany({
    data: recipients.map((r) => ({
      campaignId,
      leadId: r.leadId,
      recipient: r.email,
      status: r.status ?? "pending",
      attempts: r.attempts ?? 0,
      lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt ?? null,
      // An explicit createdAt matters: these tests assert on ORDERING, so the
      // clock must not be what decides it.
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    })),
  });
  return prisma.campaignRecipient.findMany({
    where: { campaignId },
    orderBy: { id: "asc" },
  });
}