import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession, isOwner } from "@/lib/auth";
import { campaignActionSchema } from "@/lib/validation";
import { buildRecipientSeeds } from "@/lib/campaigns";
import { validateTemplateContent } from "@/lib/personalization";
import { snapshotFromTemplate } from "@/lib/templates";
import { getSendSettings } from "@/lib/settings";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

const VALID_TRANSITIONS: Record<string, string[]> = {
  start: ["draft", "stopped"],
  pause: ["active"],
  resume: ["paused"],
  stop: ["active", "paused"],
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const parsed = campaignActionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid action");
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    include: {
      template: true,
      googleAccount: true,
      microsoftAccount: true,
      smtpAccount: true,
      recipients: true,
    },
  });

  if (!campaign || !isOwner(session, campaign.userId)) {
    return notFound("Campaign not found");
  }

  const action = parsed.data.action;

  if (!VALID_TRANSITIONS[action].includes(campaign.status)) {
    return badRequest(`Cannot ${action} a campaign that is ${campaign.status}`);
  }

  const now = new Date();

  if (action === "start") {
    if (!campaign.template) {
      return badRequest("Select an email template");
    }

    const validation = validateTemplateContent(
      campaign.template.subject,
      campaign.template.body,
    );

    if (!validation.ok) {
      return badRequest(
        `Email template has issues: ${validation.errors.join(" ")}`,
      );
    }

    if (
      !campaign.googleAccount &&
      !campaign.microsoftAccount &&
      !campaign.smtpAccount
    ) {
      // Fall back to the most recently connected sending account.
      // Supports Gmail, Outlook, and SMTP.
      const [newestGoogle, newestMicrosoft, newestSmtp] =
        await Promise.all([
          prisma.googleAccount.findFirst({
            where: { userId: session.sub },
            orderBy: { updatedAt: "desc" },
          }),
          prisma.microsoftAccount.findFirst({
            where: { userId: session.sub },
            orderBy: { updatedAt: "desc" },
          }),
          prisma.smtpAccount.findFirst({
            where: { userId: session.sub },
            orderBy: { updatedAt: "desc" },
          }),
        ]);

      const googleTime = newestGoogle?.updatedAt.getTime() ?? 0;
      const microsoftTime = newestMicrosoft?.updatedAt.getTime() ?? 0;
      const smtpTime = newestSmtp?.updatedAt.getTime() ?? 0;

      const latestTime = Math.max(
        googleTime,
        microsoftTime,
        smtpTime,
      );

      if (newestSmtp && smtpTime === latestTime) {
        campaign.smtpAccount = newestSmtp;

        await prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            smtpAccountId: newestSmtp.id,
            googleAccountId: null,
            microsoftAccountId: null,
          },
        });
      } else if (newestMicrosoft && microsoftTime === latestTime) {
        campaign.microsoftAccount = newestMicrosoft;

        await prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            microsoftAccountId: newestMicrosoft.id,
            googleAccountId: null,
            smtpAccountId: null,
          },
        });
      } else if (newestGoogle) {
        campaign.googleAccount = newestGoogle;

        await prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            googleAccountId: newestGoogle.id,
            microsoftAccountId: null,
            smtpAccountId: null,
          },
        });
      } else {
        return badRequest(
          "Connect a Gmail, Outlook, or SMTP account first",
        );
      }
    }

    // Fresh recipients on every (re)start.
    // Already-SENT prospects keep their history and are NOT re-queued.
    const [leads, suppressions, alreadySent] = await Promise.all([
      prisma.lead.findMany({
        where: { userId: session.sub },
      }),
      prisma.suppression.findMany({
        where: { userId: session.sub },
        select: { email: true },
      }),
      prisma.campaignRecipient.findMany({
        where: {
          campaignId: campaign.id,
          status: "sent",
        },
        select: { recipient: true },
      }),
    ]);

    const sentEmails = new Set(
      alreadySent.map((r) => r.recipient.toLowerCase()),
    );

    const suppressedEmails = new Set(
      suppressions.map((s) => s.email.toLowerCase()),
    );

    const seeds = buildRecipientSeeds(
      leads
        .filter((l) => !sentEmails.has(l.email.toLowerCase()))
        .map((l) => ({
          id: l.id,
          email: l.email,
          firstName: l.firstName,
          lastName: l.lastName ?? "",
          practiceName: l.practiceName ?? "",
        })),
      suppressedEmails,
    );

    const validCount = seeds.filter(
      (s) => s.status === "pending",
    ).length;

    if (validCount === 0) {
      return badRequest(
        "No valid recipients to send to. Add leads or remove suppressions first.",
      );
    }

    await prisma.$transaction([
      prisma.campaignRecipient.deleteMany({
        where: {
          campaignId: campaign.id,
          status: { not: "sent" },
        },
      }),
      prisma.campaignRecipient.createMany({
        data: seeds.map((s) => ({
          campaignId: campaign.id,
          leadId: s.leadId,
          recipient: s.recipient,
          status: s.status,
          lastError: s.lastError,
        })),
      }),
    ]);

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "active",
        startedAt: now,
        stoppedAt: null,
        completedAt: null,
        pausedAt: null,
        pausedReason: null,
        templateSnapshot:
          snapshotFromTemplate(
            campaign.template,
          ) as unknown as Prisma.InputJsonValue,
      },
    });

    const settings = await getSendSettings(session.sub);

    return jsonResponse({
      ok: true,
      status: "active",
      recipients: seeds.length,
      estimatedSeconds:
        seeds.length * settings.minDelaySeconds,
      sendMode: settings.sendMode,
    });
  }

  if (
    action === "pause" ||
    action === "stop" ||
    action === "resume"
  ) {
    const nextStatus =
      action === "pause"
        ? "paused"
        : action === "stop"
          ? "stopped"
          : "active";

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: nextStatus,
        stoppedAt: action === "stop" ? now : undefined,
        startedAt: action === "resume" ? now : undefined,
        pausedAt:
          action === "pause"
            ? now
            : action === "resume"
              ? null
              : undefined,
        pausedReason:
          action === "pause"
            ? "Paused by user"
            : action === "resume"
              ? null
              : undefined,
      },
    });

    return jsonResponse({
      ok: true,
      status: nextStatus,
    });
  }

  return badRequest("Unsupported action");
}