import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { campaignCreateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import type { RecipientStatus } from "@/lib/campaigns";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const campaigns = await prisma.campaign.findMany({
    where: { userId: session.sub },
    orderBy: { updatedAt: "desc" },
    include: { template: true, googleAccount: true, microsoftAccount: true, smtpAccount: true },
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
      googleEmail: c.googleAccount?.googleEmail ?? null,
      microsoftEmail: c.microsoftAccount?.microsoftEmail ?? null,
      smtpEmail: c.smtpAccount?.email ?? null,
      senderEmail: c.googleAccount?.googleEmail ?? c.microsoftAccount?.microsoftEmail ?? c.smtpAccount?.email ?? null,
      senderProvider: c.smtpAccount ? "smtp" : c.microsoftAccount ? "microsoft" : c.googleAccount ? "google" : null,
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

  const provider = parsed.data.smtpAccountId
    ? "smtp"
    : parsed.data.microsoftAccountId
      ? "microsoft"
      : "google";
  const accountId = parsed.data.smtpAccountId ?? parsed.data.microsoftAccountId ?? parsed.data.googleAccountId!;

  const [template, googleAccount, microsoftAccount, smtpAccount, leadCount] = await Promise.all([
    prisma.emailTemplate.findUnique({ where: { id: parsed.data.templateId } }),
    provider === "google"
      ? prisma.googleAccount.findUnique({ where: { id: accountId } })
      : Promise.resolve(null),
    provider === "microsoft"
      ? prisma.microsoftAccount.findUnique({ where: { id: accountId } })
      : Promise.resolve(null),
    provider === "smtp"
      ? prisma.smtpAccount.findUnique({ where: { id: accountId } })
      : Promise.resolve(null),
    prisma.lead.count({ where: { userId: session.sub } }),
  ]);

  if (!template || template.userId !== session.sub)
    return notFound("Template not found");
  const account = provider === "google" ? googleAccount : provider === "microsoft" ? microsoftAccount : smtpAccount;
  if (!account || account.userId !== session.sub)
    return notFound("Sending account not found");
  if (leadCount === 0)
    return badRequest("Import leads before creating a campaign");

  const campaign = await prisma.campaign.create({
    data: {
      userId: session.sub,
      name: parsed.data.name,
      templateId: template.id,
      ...(provider === "google"
        ? { googleAccountId: account.id }
        : provider === "microsoft"
          ? { microsoftAccountId: account.id }
          : { smtpAccountId: account.id }),
      status: "draft",
    },
  });

  return jsonResponse({ campaign }, 201);
}