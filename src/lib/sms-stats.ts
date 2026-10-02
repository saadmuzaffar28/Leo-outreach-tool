import { prisma } from "@/lib/prisma";

export interface SmsKpis {
  totalSent: number;
  delivered: number;
  deliveryRate: number;
  failed: number;
  replies: number;
  replyRate: number;
  optOuts: number;
  optOutRate: number;
}

export interface SmsCampaignRow {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  scheduledAt: Date | null;
  audience: number;
  sent: number;
  delivered: number;
  failed: number;
  replies: number;
  replyRate: number;
  optOuts: number;
}

export interface SmsFilter {
  from?: Date;
  to?: Date;
  campaignId?: string;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

export async function getSmsKpis(userId: string, filter: SmsFilter = {}): Promise<SmsKpis> {
  const where = {
    userId,
    direction: "outbound" as const,
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };

  const [totalSent, delivered, failed, replies, contactCount, optOuts] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.count({ where: { ...where, status: "delivered" } }),
    prisma.message.count({
      where: { ...where, status: { in: ["failed", "undelivered", "rejected"] } },
    }),
    prisma.reply.count({
      where: {
        userId,
        ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
        ...(filter.from || filter.to
          ? { receivedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
    }),
    prisma.contact.count({ where: { userId } }),
    prisma.contact.count({ where: { userId, optOut: true } }),
  ]);

  return {
    totalSent,
    delivered,
    deliveryRate: pct(delivered, totalSent),
    failed,
    replies,
    replyRate: pct(replies, totalSent),
    optOuts,
    optOutRate: pct(optOuts, Math.max(contactCount, optOuts)),
  };
}

export async function getSmsCampaignRows(userId: string): Promise<SmsCampaignRow[]> {
  const campaigns = await prisma.smsCampaign.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  const ids = campaigns.map((c) => c.id);
  if (ids.length === 0) return [];

  const [msgCounts, replyCounts] = await Promise.all([
    prisma.message.groupBy({
      by: ["campaignId", "status"],
      where: { userId, campaignId: { in: ids }, direction: "outbound" },
      _count: { _all: true },
    }),
    prisma.reply.groupBy({
      by: ["campaignId"],
      where: { userId, campaignId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const msgBy = new Map<string, Record<string, number>>();
  for (const row of msgCounts) {
    if (!row.campaignId) continue;
    const bucket = msgBy.get(row.campaignId) ?? {};
    bucket[row.status] = row._count._all;
    msgBy.set(row.campaignId, bucket);
  }
  const repliesBy = new Map<string, number>();
  for (const row of replyCounts) {
    if (row.campaignId) repliesBy.set(row.campaignId, row._count._all);
  }

  const audience = await prisma.message.groupBy({
    by: ["campaignId"],
    where: { userId, campaignId: { in: ids }, direction: "outbound" },
    _count: { _all: true },
  });
  const audienceBy = new Map(audience.map((a) => [a.campaignId ?? "", a._count._all]));

  return campaigns.map((c) => {
    const bucket = msgBy.get(c.id) ?? {};
    const sent = (bucket["sent"] ?? 0) + (bucket["delivered"] ?? 0);
    const delivered = bucket["delivered"] ?? 0;
    const failed =
      (bucket["failed"] ?? 0) + (bucket["undelivered"] ?? 0) + (bucket["rejected"] ?? 0);
    const replies = repliesBy.get(c.id) ?? 0;
    const recipients = audienceBy.get(c.id) ?? 0;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      scheduledAt: c.scheduledAt,
      audience: recipients,
      sent,
      delivered,
      failed,
      replies,
      replyRate: pct(replies, sent),
      optOuts: 0, // per-campaign opt-outs tracked via contact flags; filled below
    };
  });
}

export interface TimeSeriesPoint {
  date: string;
  sent: number;
  delivered: number;
  failed: number;
  replies: number;
}

export async function getMessagesOverTime(
  userId: string,
  days = 30,
  campaignId?: string,
): Promise<TimeSeriesPoint[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const base = {
    userId,
    createdAt: { gte: since },
    ...(campaignId ? { campaignId } : {}),
  };

  const [messages, replies] = await Promise.all([
    prisma.message.findMany({
      where: { ...base, direction: "outbound" },
      select: { createdAt: true, status: true },
    }),
    prisma.reply.findMany({
      where: { userId, receivedAt: { gte: since }, ...(campaignId ? { campaignId } : {}) },
      select: { receivedAt: true },
    }),
  ]);

  const points = new Map<string, TimeSeriesPoint>();
  for (let i = 0; i <= days; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    points.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), sent: 0, delivered: 0, failed: 0, replies: 0 });
  }

  for (const m of messages) {
    const key = m.createdAt.toISOString().slice(0, 10);
    const p = points.get(key);
    if (!p) continue;
    p.sent += 1;
    if (m.status === "delivered") p.delivered += 1;
    if (["failed", "undelivered", "rejected"].includes(m.status)) p.failed += 1;
  }
  for (const r of replies) {
    const key = r.receivedAt.toISOString().slice(0, 10);
    const p = points.get(key);
    if (p) p.replies += 1;
  }

  return Array.from(points.values());
}
