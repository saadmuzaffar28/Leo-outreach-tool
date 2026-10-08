import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { env } from "@/lib/env";
import { buildRecipientSeeds, estimateDuration } from "@/lib/campaigns";
import { getSendSettings } from "@/lib/settings";
import { personalize, PREVIEW_LEAD, validateTemplateContent } from "@/lib/personalization";
import { groupLeadWhere } from "@/lib/groups";
import { coercePolicy, decideGate } from "@/lib/verification/gate";
import { statusesFor } from "@/lib/verification/service";
import type { VerificationStatus } from "@/lib/verification/types";
import { forbidden, jsonResponse, notFound } from "@/lib/http";

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

  const [leads, suppressions, settings] = await Promise.all([
    // The campaign's audience is its selected group (or every lead when no
    // group was chosen) — NEVER all of the user's leads. This must mirror the
    // start route's seeding exactly, or a grouped campaign would preview the
    // wrong recipient count. See status/route.ts (same `groupLeadWhere`).
    prisma.lead.findMany({
      where: groupLeadWhere(session.sub, campaign.recipientGroupId),
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

  // Pre-flight view of the verification gate — mirrors exactly what the
  // start route will do, so the operator sees the skips BEFORE starting.
  const verificationPolicy = coercePolicy(campaign.verificationPolicy);
  let verificationBlockedCount = 0;
  let unverifiedCount = 0;
  if (verificationPolicy !== "OFF" && verificationPolicy !== "WARN") {
    const verificationRows = await statusesFor(
      session.sub,
      seeds.filter((s) => s.status === "pending").map((s) => s.recipient),
    );
    for (const seed of seeds) {
      if (seed.status !== "pending") continue;
      const row = verificationRows.get(seed.recipient);
      if (!row) {
        unverifiedCount++;
        continue;
      }
      if (decideGate(verificationPolicy, row.status as VerificationStatus).block) {
        verificationBlockedCount++;
      }
    }
  }

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
    validRecipientCount:
      seeds.filter((s) => s.status === "pending").length - verificationBlockedCount,
    suppressedCount: seeds.filter((s) => s.status === "skipped").length,
    duplicatesRemoved: leads.length - seeds.length,
    // Email verification gate (Phase 13) — zero when the policy is OFF/WARN.
    verificationPolicy,
    verificationBlockedCount,
    unverifiedCount,
    googleEmail: campaign.googleAccount?.googleEmail ?? null,
    // Resolved exactly as the worker resolves it, so the pre-flight panel shows
    // the real From display name rather than making the operator guess.
    senderName: campaign.senderName?.trim() || env.SENDER_NAME,
    senderEmail: campaign.googleAccount?.googleEmail ?? campaign.microsoftAccount?.microsoftEmail ?? null,
    senderProvider: campaign.smtpAccount
      ? "smtp"
      : campaign.microsoftAccount
        ? "microsoft"
        : campaign.googleAccount
          ? "google"
          : null,
    // The campaign's selected sending mailboxes, in position order. The client
    // folds these into the distribution preview via the shared helper.
    smtpMailboxes: campaign.sendingAccounts.map((s) => ({
      id: s.smtpAccountId,
      email: s.smtpAccount?.email ?? null,
      displayName: s.smtpAccount?.displayName ?? null,
    })),
    estimatedDuration: estimateDuration(seeds.length, settings.minDelaySeconds),
    sampleRecipients: leads.slice(0, 5).map((l) => l.email),
    sendMode: settings.sendMode,
  });
}