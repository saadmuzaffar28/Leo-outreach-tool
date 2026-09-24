import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { buildRecipientSeeds, estimateDuration } from "@/lib/campaigns";
import { getSendSettings } from "@/lib/settings";
import { personalize, PREVIEW_LEAD, validateTemplateContent } from "@/lib/personalization";
import { forbidden, jsonResponse, notFound } from "@/lib/http";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    include: { template: true, googleAccount: true, microsoftAccount: true },
  });
  if (!campaign || !isOwner(session, campaign.userId)) return notFound("Campaign not found");

  const [leads, suppressions, settings] = await Promise.all([
    prisma.lead.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: "desc" },
    }),
    prisma.suppression.findMany({
      where: { userId: session.sub },
      select: { email: true },
    }),
    getSendSettings(session.sub),
  ]);

  const suppressedEmails = new Set(suppressions.map((s) => s.email.toLowerCase()));
  const seeds = buildRecipientSeeds(
    leads.map((l) => ({
      id: l.id,
      email: l.email,
      firstName: l.firstName,
      lastName: l.lastName ?? "",
      practiceName: l.practiceName ?? "",
    })),
    suppressedEmails,
  );

  const validation = campaign.template
    ? validateTemplateContent(campaign.template.subject, campaign.template.body)
    : { ok: false, errors: ["Select an email template"] };

  return jsonResponse({
    templateId: campaign.templateId,
    templateName: campaign.template?.name ?? null,
    subject: campaign.template ? personalize(campaign.template.subject, PREVIEW_LEAD).trim() : "",
    body: campaign.template ? personalize(campaign.template.body, PREVIEW_LEAD) : "",
    validation,
    recipientCount: leads.length,
    validRecipientCount: seeds.filter((s) => s.status === "pending").length,
    suppressedCount: seeds.filter((s) => s.status === "skipped").length,
    duplicatesRemoved: leads.length - seeds.length,
    googleEmail: campaign.googleAccount?.googleEmail ?? null,
    senderEmail: campaign.googleAccount?.googleEmail ?? campaign.microsoftAccount?.microsoftEmail ?? null,
    senderProvider: campaign.microsoftAccount ? "microsoft" : campaign.googleAccount ? "google" : null,
    estimatedDuration: estimateDuration(seeds.length, settings.minDelaySeconds),
    sampleRecipients: leads.slice(0, 5).map((l) => l.email),
    sendMode: settings.sendMode,
  });
}