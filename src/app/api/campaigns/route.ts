import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { campaignCreateSchema } from "@/lib/validation";
import { groupLeadWhere } from "@/lib/groups";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import type { RecipientStatus } from "@/lib/campaigns";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const campaigns = await prisma.campaign.findMany({
    where: { userId: session.sub },
    orderBy: { updatedAt: "desc" },
    include: {
      template: true,
      googleAccount: true,
      microsoftAccount: true,
      smtpAccount: true,
      recipientGroup: true,
      sendingAccounts: { include: { smtpAccount: true }, orderBy: { position: "asc" } },
    },
  });

  const ids = campaigns.map((c) => c.id);
  const counts = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: ids } },
    _count: { _all: true },
  });

  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const bucket = byCampaign.get(row.campaignId) ?? {};
    bucket[row.status] = row._count._all;
    byCampaign.set(row.campaignId, bucket);
  }

  const keys: RecipientStatus[] = ["pending", "sending", "sent", "failed", "skipped"];
  const list = campaigns.map((c) => {
    const bucket = byCampaign.get(c.id) ?? {};
    const recipients = keys.reduce<Record<string, number>>(
      (acc, k) => ({ ...acc, [k]: bucket[k] ?? 0 }),
      {},
    );
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      templateName: c.template?.name ?? null,
      recipientGroupName: c.recipientGroup?.name ?? null,
      googleEmail: c.googleAccount?.googleEmail ?? null,
      microsoftEmail: c.microsoftAccount?.microsoftEmail ?? null,
      smtpEmail: c.smtpAccount?.email ?? null,
      senderEmail: c.googleAccount?.googleEmail ?? c.microsoftAccount?.microsoftEmail ?? c.smtpAccount?.email ?? null,
      senderProvider: c.smtpAccount ? "smtp" : c.microsoftAccount ? "microsoft" : c.googleAccount ? "google" : null,
      smtpMailboxes: c.sendingAccounts.map((s) => ({
        id: s.smtpAccountId,
        email: s.smtpAccount?.email ?? null,
      })),
      smtpMailboxCount: c.sendingAccounts.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      startedAt: c.startedAt,
      recipients,
    };
  });

  return jsonResponse({ campaigns: list });
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = campaignCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid campaign");

  // Single-group contract: a campaign targets EXACTLY ONE group. A plural
  // `recipientGroupIds` is not a supported field and must never be silently
  // dropped (zod strips unknown keys) — ignoring it would fall back to
  // "every lead" and blast the whole contact list. Reject it loudly.
  const rawBody = body as Record<string, unknown> | null;
  if (rawBody && Array.isArray(rawBody.recipientGroupIds) && !parsed.data.recipientGroupId) {
    return badRequest("Select exactly one group: send recipientGroupId (a single group id), not recipientGroupIds.");
  }

  // Multi-mailbox selection (1..N connected SMTP mailboxes). The legacy
  // single-account fields keep working: `smtpAccountId` is treated as a
  // one-element selection, and Gmail/Outlook campaigns are unchanged.
  const selectedSmtpIds = Array.from(
    new Set(parsed.data.smtpAccountIds ?? (parsed.data.smtpAccountId ? [parsed.data.smtpAccountId] : [])),
  );
  const isSmtp = selectedSmtpIds.length > 0;
  const isMicrosoft = Boolean(parsed.data.microsoftAccountId);
  const isGoogle = Boolean(parsed.data.googleAccountId);
  const accountId = isSmtp
    ? selectedSmtpIds[0]
    : (parsed.data.microsoftAccountId ?? parsed.data.googleAccountId!);

  // A campaign may target a group. The id is validated up front so a bad or
  // foreign group is rejected at creation time rather than at send time.
  let recipientGroup: { id: string; name: string } | null = null;
  if (parsed.data.recipientGroupId) {
    const found = await prisma.group.findUnique({
      where: { id: parsed.data.recipientGroupId },
    });
    if (!found || found.userId !== session.sub) return notFound("Group not found");
    recipientGroup = { id: found.id, name: found.name };
  }

  const [template, googleAccount, microsoftAccount, smtpAccounts, leadCount] = await Promise.all([
    prisma.emailTemplate.findUnique({ where: { id: parsed.data.templateId } }),
    isGoogle
      ? prisma.googleAccount.findUnique({ where: { id: accountId } })
      : Promise.resolve(null),
    isMicrosoft
      ? prisma.microsoftAccount.findUnique({ where: { id: accountId } })
      : Promise.resolve(null),
    isSmtp
      ? prisma.smtpAccount.findMany({ where: { id: { in: selectedSmtpIds } } })
      : Promise.resolve([]),
    prisma.lead.count({ where: groupLeadWhere(session.sub, recipientGroup?.id ?? null) }),
  ]);

  if (!template || template.userId !== session.sub)
    return notFound("Template not found");

  if (isGoogle || isMicrosoft) {
    const account = isGoogle ? googleAccount : microsoftAccount;
    if (!account || account.userId !== session.sub)
      return notFound("Sending account not found");
  } else {
    // SMTP: preserve the operator's chosen order, and reject unknown, foreign
    // or disconnected mailboxes — a mailbox that can't send today must not be
    // newly selectable.
    const smtpById = new Map(smtpAccounts.map((a) => [a.id, a]));
    const orderedSmtp = selectedSmtpIds
      .map((id) => smtpById.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    if (orderedSmtp.length !== selectedSmtpIds.length)
      return notFound("Sending account not found");
    if (orderedSmtp.some((a) => a.userId !== session.sub))
      return notFound("Sending account not found");
    const disconnected = orderedSmtp.find((a) => a.status !== "connected");
    if (disconnected)
      return badRequest(`Mailbox "${disconnected.email}" is not connected. Reconnect it in Settings first.`);
  }

  if (leadCount === 0)
    return badRequest(
      recipientGroup
        ? `Group "${recipientGroup.name}" has no contacts yet`
        : "Import leads before creating a campaign",
    );

  const campaign = await prisma.campaign.create({
    data: {
      userId: session.sub,
      name: parsed.data.name,
      templateId: template.id,
      ...(isGoogle
        ? { googleAccountId: accountId }
        : isMicrosoft
          ? { microsoftAccountId: accountId }
          : { smtpAccountId: selectedSmtpIds[0] }),
      // The full multi-mailbox selection in deterministic position order. The
      // first mailbox also fills the legacy Campaign.smtpAccountId so existing
      // reads (list, detail, pause-by-account) keep working unchanged.
      ...(isSmtp
        ? {
            sendingAccounts: {
              create: selectedSmtpIds.map((id, i) => ({ smtpAccountId: id, position: i })),
            },
          }
        : {}),
      recipientGroupId: recipientGroup?.id ?? null,
      // null (not "") so the worker falls back to the global SENDER_NAME.
      senderName: parsed.data.senderName ?? null,
      // Verification policy defaults to OFF in the schema — existing campaigns
      // and older clients keep their previous send behaviour.
      verificationPolicy: parsed.data.verificationPolicy ?? "OFF",
      status: "draft",
    },
  });

  return jsonResponse({ campaign, recipientGroup }, 201);
}