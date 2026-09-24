import { prisma } from "@/lib/prisma";
import { getSendSettings } from "@/lib/settings";
import { dailyKey, getDailyCounter, isQuotaPaused } from "@/lib/quota";
import { effectiveMessagesPerMinute } from "@/lib/rate-limiter";

export interface CampaignStatRow {
  id: string;
  name: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
}

export async function getDashboardStats(userId: string) {
  const [leadCount, googleAccountCount, microsoftAccountCount, activeCampaigns, emailsSent, emailsFailed, emailsPending, suppressed, campaignRows] =
    await Promise.all([
      prisma.lead.count({ where: { userId } }),
      prisma.googleAccount.count({ where: { userId } }),
      prisma.microsoftAccount.count({ where: { userId } }),
      prisma.campaign.count({ where: { userId, status: { in: ["active", "paused"] } } }),
      prisma.campaignRecipient.count({
        where: { campaign: { userId }, status: "sent" },
      }),
      prisma.campaignRecipient.count({
        where: { campaign: { userId }, status: "failed" },
      }),
      prisma.campaignRecipient.count({
        where: { campaign: { userId }, status: { in: ["pending", "sending"] } },
      }),
      prisma.suppression.count({ where: { userId } }),
      prisma.campaign.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true, status: true },
        take: 10,
      }),
    ]);

  const accountCount = googleAccountCount + microsoftAccountCount;

  const counts = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"],
    where: {
      campaign: { userId },
      campaignId: { in: campaignRows.map((c) => c.id) },
    },
    _count: { _all: true },
  });

  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const bucket = byCampaign.get(row.campaignId) ?? {};
    bucket[row.status] = row._count._all;
    byCampaign.set(row.campaignId, bucket);
  }

  const campaigns: CampaignStatRow[] = campaignRows.map((c) => {
    const bucket = byCampaign.get(c.id) ?? {};
    const sent = bucket["sent"] ?? 0;
    const failed = bucket["failed"] ?? 0;
    const skipped = bucket["skipped"] ?? 0;
    const pending = bucket["pending"] ?? 0;
    const sending = bucket["sending"] ?? 0;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      total: sent + failed + skipped + pending + sending,
      sent,
      failed,
      skipped,
      remaining: pending + sending,
    };
  });

  return {
    leadCount,
    accountCount,
    activeCampaigns,
    emailsSent,
    emailsFailed,
    emailsPending,
    suppressed,
    campaigns,
  };
}

export interface AccountUsageRow {
  accountId: string;
  provider: "google" | "microsoft";
  email: string;
  messagesSent: number;
  messagesFailed: number;
  messagesSkipped: number;
  quotaPaused: boolean;
  quotaPausedUntil: Date | null;
  quotaMessage: string | null;
}

export interface SendDashboard {
  settings: {
    dailySendLimit: number;
    messagesPerMinute: number;
    minDelaySeconds: number;
    effectivePerMinute: number;
    sendMode: string;
    maxRetryAttempts: number;
  };
  usage: AccountUsageRow[];
}

export async function getSendDashboard(userId: string): Promise<SendDashboard> {
  const [googleAccounts, microsoftAccounts, settings] = await Promise.all([
    prisma.googleAccount.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.microsoftAccount.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    getSendSettings(userId),
  ]);

  const today = dailyKey();
  const googleUsage = await Promise.all(
    googleAccounts.map(async (a) => {
      const c = await getDailyCounter("google", a.id, userId, today);
      return {
        accountId: a.id,
        provider: "google" as const,
        email: a.googleEmail,
        messagesSent: c.messagesSent,
        messagesFailed: c.messagesFailed,
        messagesSkipped: c.messagesSkipped,
        quotaPaused: isQuotaPaused(a.quotaPausedUntil),
        quotaPausedUntil: a.quotaPausedUntil,
        quotaMessage: a.quotaMessage,
      };
    }),
  );
  const microsoftUsage = await Promise.all(
    microsoftAccounts.map(async (a) => {
      const c = await getDailyCounter("microsoft", a.id, userId, today);
      return {
        accountId: a.id,
        provider: "microsoft" as const,
        email: a.microsoftEmail,
        messagesSent: c.messagesSent,
        messagesFailed: c.messagesFailed,
        messagesSkipped: c.messagesSkipped,
        quotaPaused: isQuotaPaused(a.quotaPausedUntil),
        quotaPausedUntil: a.quotaPausedUntil,
        quotaMessage: a.quotaMessage,
      };
    }),
  );
  const usage = [...googleUsage, ...microsoftUsage];

  return {
    settings: {
      dailySendLimit: settings.dailySendLimit,
      messagesPerMinute: settings.messagesPerMinute,
      minDelaySeconds: settings.minDelaySeconds,
      effectivePerMinute: effectiveMessagesPerMinute({
        messagesPerMinute: settings.messagesPerMinute,
        minDelaySeconds: settings.minDelaySeconds,
      }),
      sendMode: settings.sendMode,
      maxRetryAttempts: settings.maxRetryAttempts,
    },
    usage,
  };
}