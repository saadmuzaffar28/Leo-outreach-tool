// Read-only inspection of the send queue. Explains whether the running worker
// will pick the campaign up, and if not, exactly why. Changes nothing.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const now = new Date();

try {
  const settings = await prisma.sendSettings.findFirst();
  console.log("=== SEND MODE ===");
  console.log("  sendMode            :", settings?.sendMode ?? "(default 'live')");
  console.log("  dailySendLimit      :", settings?.dailySendLimit ?? 100, "per account");
  console.log("  messagesPerMinute   :", settings?.messagesPerMinute ?? 3, "(in-process token bucket)");
  console.log("  min/maxDelaySeconds :", settings?.minDelaySeconds ?? 20, "/", settings?.maxDelaySeconds ?? 60);

  const campaigns = await prisma.campaign.findMany({
    include: { googleAccount: true, template: true, recipientGroup: true, _count: { select: { recipients: true } } },
    orderBy: { createdAt: "desc" },
  });

  console.log("");
  console.log("=== CAMPAIGNS (" + campaigns.length + ") ===");
  if (campaigns.length === 0) console.log("  none");

  for (const c of campaigns) {
    console.log("  --- " + c.name + "  [" + c.status + "]");
    console.log("      sender     : " + (c.googleAccount?.googleEmail ?? "(none set)"));
    console.log("      template   : " + (c.templateId ?? "(none)"));
    console.log("      group      : " + (c.recipientGroup?.name ?? "All contacts"));
    console.log("      recipients : " + c._count.recipients);
    if (c.pausedReason) console.log("      PAUSED     : " + c.pausedReason);

    const byStatus = await prisma.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: c.id },
      _count: { _all: true },
    });
    for (const s of byStatus) console.log("      " + s.status.padEnd(9) + ": " + s._count._all);

    // Recipients the worker could claim right now.
    const claimable = await prisma.campaignRecipient.count({
      where: {
        campaignId: c.id,
        OR: [{ status: "pending" }, { status: "sending", nextAttemptAt: { lte: now } }],
      },
    });
    const blocked = await prisma.campaignRecipient.findMany({
      where: { campaignId: c.id, status: { notIn: ["pending", "sending"] } },
      select: { recipient: true, status: true, lastError: true },
      take: 10,
    });
    console.log("      claimable now : " + claimable);
    if (blocked.length) {
      console.log("      not claimable :");
      for (const b of blocked) {
        console.log("         " + b.recipient + "  " + b.status + (b.lastError ? "  (" + b.lastError + ")" : ""));
      }
    }

    // Per-account quota state: this is the other thing that silently halts sending.
    if (c.googleAccountId) {
      const acct = await prisma.googleAccount.findUnique({
        where: { id: c.googleAccountId },
        select: { googleEmail: true, status: true, quotaPausedUntil: true, quotaMessage: true },
      });
      const counters = await prisma.dailySendCounter.findMany({ where: { provider: "google", accountId: c.googleAccountId } });
      console.log("      account status: " + acct?.status + (acct?.quotaPausedUntil ? "  quotaPausedUntil=" + acct.quotaPausedUntil : ""));
      if (acct?.quotaMessage) console.log("      quota message : " + acct.quotaMessage);
      for (const k of counters) {
        console.log("      counter " + k.date + ": sent=" + k.messagesSent + " failed=" + k.messagesFailed + " skipped=" + k.messagesSkipped);
      }
    }
  }

  console.log("");
  console.log("=== VERDICT ===");
  const active = campaigns.filter((c) => c.status === "active");
  if (active.length === 0) {
    console.log("  No campaign is in 'active' state -- nothing will be sent.");
  } else {
    console.log("  " + active.length + " active campaign(s). The PM2 worker polls every ~20s,");
    console.log("  so no manual start is needed.");
  }
  console.log("");
  console.log("=== WORKER PROCESSES RUNNING RIGHT NOW ===");
  console.log("  (checked separately by the caller)");
} catch (e) {
  console.log("ERROR: " + (e?.message ?? String(e)));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
