import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession, isOwner } from "@/lib/auth";
import { campaignUpdateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import type { RecipientStatus } from "@/lib/campaigns";

const STATUS_KEYS: RecipientStatus[] = ["pending", "sending", "sent", "failed", "skipped"];

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    include: {
      template: true,
      googleAccount: true,
      microsoftAccount: true,
      smtpAccount: true,
      sendingAccounts: { include: { smtpAccount: true }, orderBy: { position: "asc" } },
    },
  });
  if (!campaign || !isOwner(session, campaign.userId)) return notFound("Campaign not found");

  const [counts, suppressedTotal] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    }),
    prisma.suppression.count({ where: { userId: session.sub } }),
  ]);

  const stats = STATUS_KEYS.reduce<Record<string, number>>((acc, k) => {
    acc[k] = counts.find((r) => r.status === k)?._count._all ?? 0;
    return acc;
  }, {});

  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId: campaign.id },
    orderBy: { createdAt: "asc" },
    include: { lead: true, smtpAccount: { select: { email: true } } },
  });

  return jsonResponse({
    campaign,
    stats,
    suppressedTotal,
    recipients: recipients.map((r) => ({
      id: r.id,
      status: r.status,
      recipient: r.recipient,
      firstName: r.lead?.firstName ?? null,
      practiceName: r.lead?.practiceName ?? null,
      subject: r.subject,
      attempts: r.attempts,
      lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt,
      sentAt: r.sentAt,
      // The frozen sending mailbox this recipient was assigned at campaign start.
      smtpAccountId: r.smtpAccountId,
      smtpMailboxEmail: r.smtpAccount?.email ?? null,
    })),
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign || !isOwner(session, campaign.userId)) return notFound("Campaign not found");

  if (campaign.status !== "draft" && campaign.status !== "stopped") {
    return badRequest("The email template and sending mailboxes can only be changed before a campaign starts");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = campaignUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid update");

  // Verification gate change — allowed whenever (the worker reads the policy
  // per tick, so tightening/loosening applies to the next send loop).
  if (parsed.data.verificationPolicy !== undefined) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { verificationPolicy: parsed.data.verificationPolicy },
    });
  }

  // Template change (legacy behaviour, unchanged).
  if (parsed.data.templateId !== undefined) {
    const template = await prisma.emailTemplate.findUnique({ where: { id: parsed.data.templateId } });
    if (!template || !isOwner(session, template.userId)) return notFound("Template not found");
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        templateId: template.id,
        templateSnapshot: Prisma.DbNull,
      },
    });
  }

  // Sending-mailbox selection change (draft/stopped only). Recipients do not
  // exist yet for drafts; for a stopped campaign, rows that were already sent
  // or attempted keep their frozen mailbox assignment and are never rewritten
  // here — only the selection used by the NEXT start is replaced.
  if (parsed.data.smtpAccountIds !== undefined) {
    const selectedSmtpIds = Array.from(new Set(parsed.data.smtpAccountIds));

    const smtpAccounts = await prisma.smtpAccount.findMany({
      where: { id: { in: selectedSmtpIds } },
    });
    const smtpById = new Map(smtpAccounts.map((a) => [a.id, a]));
    const orderedSmtp = selectedSmtpIds
      .map((id) => smtpById.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    if (orderedSmtp.length !== selectedSmtpIds.length || orderedSmtp.some((a) => a.userId !== session.sub)) {
      return notFound("Sending account not found");
    }
    const disconnected = orderedSmtp.find((a) => a.status !== "connected");
    if (disconnected) {
      return badRequest(`Mailbox "${disconnected.email}" is not connected. Reconnect it in Settings first.`);
    }

    await prisma.$transaction([
      prisma.campaignSendingAccount.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.campaignSendingAccount.createMany({
        data: orderedSmtp.map((a, i) => ({ campaignId: campaign.id, smtpAccountId: a.id, position: i })),
      }),
      prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          smtpAccountId: orderedSmtp[0].id,
          googleAccountId: null,
          microsoftAccountId: null,
        },
      }),
    ]);
  }

  const updated = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  return jsonResponse({ campaign: updated });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign || !isOwner(session, campaign.userId)) return notFound("Campaign not found");

  if (campaign.status === "active") {
    return jsonResponse({ error: "Stop the campaign before deleting it" }, 409);
  }
  await prisma.campaign.delete({ where: { id: campaign.id } });
  return jsonResponse({ ok: true });
}