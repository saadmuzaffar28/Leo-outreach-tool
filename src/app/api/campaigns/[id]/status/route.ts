import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession, isOwner } from "@/lib/auth";
import { campaignActionSchema } from "@/lib/validation";
import { buildRecipientSeeds, distributeRecipientsAcrossAccounts } from "@/lib/campaigns";
import { groupLeadWhere } from "@/lib/groups";
import { coercePolicy, decideGate } from "@/lib/verification/gate";
import { statusesFor } from "@/lib/verification/service";
import type { VerificationStatus } from "@/lib/verification/types";
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
      recipientGroup: true,
      recipients: true,
      sendingAccounts: { orderBy: { position: "asc" } },
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

    // Hydrate the multi-mailbox join table for legacy SMTP campaigns: a draft
    // created before this feature (or one that fell back to the newest mailbox
    // above) has a single `smtpAccountId` but no `sendingAccounts` rows. The
    // join table is the canonical selection from here on.
    if (campaign.smtpAccount && campaign.sendingAccounts.length === 0) {
      await prisma.campaignSendingAccount.create({
        data: { campaignId: campaign.id, smtpAccountId: campaign.smtpAccountId!, position: 0 },
      });
      campaign.sendingAccounts = [
        {
          id: "",
          createdAt: new Date(),
          campaignId: campaign.id,
          smtpAccountId: campaign.smtpAccountId!,
          position: 0,
        },
      ];
    }

    // Fresh recipients on every (re)start, resolved from the campaign's target
    // group (or every lead when no group is set).
    //
    // THIS IS THE SNAPSHOT. The rows written into CampaignRecipient below are
    // the campaign's permanent recipient list: the worker only ever reads those
    // rows, so adding a contact to the group later cannot add them to a running
    // campaign, and removing one cannot rewrite history.
    //
    // Already-SENT prospects keep their history and are NOT re-queued.
    //
    // A row that has ALREADY BEEN ATTEMPTED is likewise never rebuilt. See the
    // `attempted` block below: it is the difference between "this person has
    // never been emailed" and "we tried to email this person and something
    // happened", and only the second one carries a retry budget that has been
    // partly spent and an outcome that may or may not have reached the provider.
    // Deterministic lead order: the seed order decides which mailbox each
    // recipient is assigned to at start, so it must be reproducible across
    // restarts (`createdAt` alone is not unique — tie-break with the cuid id).
    const [leads, suppressions, alreadySent, attempted] = await Promise.all([
      prisma.lead.findMany({
        where: groupLeadWhere(session.sub, campaign.recipientGroupId),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
      // Everything not-yet-sent that already carries a send attempt. These rows
      // are the campaign's send-outcome history and are preserved verbatim:
      // same row, same id, same `attempts`, same `lastError`, same
      // `nextAttemptAt`, same status.
      prisma.campaignRecipient.findMany({
        where: {
          campaignId: campaign.id,
          status: { not: "sent" },
          attempts: { gt: 0 },
        },
        select: { recipient: true, status: true },
      }),
    ]);

    const sentEmails = new Set(
      alreadySent.map((r) => r.recipient.toLowerCase()),
    );

    const attemptedEmails = new Set(
      attempted.map((r) => r.recipient.toLowerCase()),
    );

    const suppressedEmails = new Set(
      suppressions.map((s) => s.email.toLowerCase()),
    );

    // Seeds for anyone we are not already tracking. `sent` and `attempted`
    // addresses are excluded so `createMany` can never collide with the
    // `@@unique([campaignId, recipient])` index or create a duplicate row.
    const seeds = buildRecipientSeeds(
      leads
        .filter(
          (l) =>
            !sentEmails.has(l.email.toLowerCase()) &&
            !attemptedEmails.has(l.email.toLowerCase()),
        )
        .map((l) => ({
          id: l.id,
          email: l.email,
          firstName: l.firstName,
          lastName: l.lastName ?? "",
          practiceName: l.practiceName ?? "",
        })),
      suppressedEmails,
    );

    // Campaign verification gate at seed time (Phase 13). Suppression was
    // already applied by buildRecipientSeeds ABOVE — only still-pending seeds
    // can be blocked here, so a suppressed address always keeps its
    // "Suppressed at campaign start" reason. Policies OFF/WARN change nothing.
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
        const gate = decideGate(verificationPolicy, row.status as VerificationStatus);
        if (gate.block) {
          // Recorded, never silent: the recipient row states the exact reason.
          seed.status = "skipped";
          seed.lastError = gate.reason ?? "verification_blocked";
          verificationBlockedCount++;
        }
      }
    }

    const validCount = seeds.filter(
      (s) => s.status === "pending",
    ).length;

    // Preserved rows that are still eligible for the worker to pick up. A
    // `sending` row here is the interesting one: its outcome is UNKNOWN (the
    // lease expired before the worker could record success or failure), so it
    // is reported to the operator rather than silently carried forward.
    const preservedActive = attempted.filter(
      (r) => r.status === "pending" || r.status === "sending",
    ).length;
    const preservedUncertain = attempted.filter(
      (r) => r.status === "sending",
    ).length;

    // A start with nothing to send is refused -- but a campaign whose ONLY
    // remaining work is already-attempted recipients is legitimate (that is
    // precisely the retry-after-a-restart case), so the preserved rows count
    // towards the guard.
    if (validCount === 0 && preservedActive === 0) {
      // The wording matters here. "Add contacts to the group" is actively
      // misleading when the real reason is that every remaining recipient has
      // already been attempted and terminally failed -- which is now reachable,
      // because those rows are (correctly) not re-seeded any more.
      return badRequest(
        attempted.length > 0
          ? "Nothing left to send: every remaining recipient has already been attempted and has no retry left. Starting will not reset their send history."
          : verificationBlockedCount > 0
            ? `Every remaining recipient is blocked by the campaign's email verification policy (${verificationBlockedCount} skipped). Change the policy, or verify/fix the addresses first.`
            : campaign.recipientGroup
              ? `No valid recipients in group "${campaign.recipientGroup.name}". Add contacts to the group or remove suppressions first.`
              : "No valid recipients to send to. Add leads or remove suppressions first.",
      );
    }

    // The delete/re-seed is now scoped to rows that have NEVER been attempted
    // (`attempts = 0`).
    //
    // Previously this deleted every non-`sent` row and rebuilt the whole seed
    // set at `attempts = 0`. That silently reset the retry budget of every
    // recipient that had already failed, and converted a stuck `sending` row
    // into a pristine `pending` one -- erasing the only evidence that a send
    // had been started at all. Restarting a campaign could therefore produce an
    // UNBOUNDED number of sends to one address.
    //
    // Untouched rows are rebuilt exactly as before, so the snapshot semantics
    // (the group is re-read on every start) are unchanged; only rows carrying
    // send history are now exempt.
    //
    // THE MAILBOX ASSIGNMENT IS FROZEN HERE, ROW BY ROW. The shared
    // deterministic distribution assigns each seed to exactly one of the
    // campaign's selected mailboxes (round-robin by seed index). Once written,
    // `smtpAccountId` is the recipient's sending mailbox forever — retries and
    // worker restarts read it, they never re-rotate. Google/Outlook campaigns
    // have no SMTP selection and stay unchanged (assignment stays NULL and the
    // worker keeps using the campaign-level account).
    const selectedSmtpIds = campaign.sendingAccounts.map((s) => s.smtpAccountId);
    const distribution =
      selectedSmtpIds.length > 0 ? distributeRecipientsAcrossAccounts(seeds, selectedSmtpIds) : null;

    await prisma.$transaction([
      prisma.campaignRecipient.deleteMany({
        where: {
          campaignId: campaign.id,
          status: { not: "sent" },
          attempts: 0,
        },
      }),
      prisma.campaignRecipient.createMany({
        data: seeds.map((s, i) => ({
          campaignId: campaign.id,
          leadId: s.leadId,
          recipient: s.recipient,
          status: s.status,
          lastError: s.lastError,
          smtpAccountId: distribution ? (distribution.accountByRecipient[i] ?? null) : null,
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

    const queued = validCount + preservedActive;

    return jsonResponse({
      ok: true,
      status: "active",
      recipients: queued,
      // Operator-visible breakdown of what the restart did NOT reset.
      preservedRecipients: attempted.length,
      uncertainRecipients: preservedUncertain,
      // Verification gate effect at seed time (0 when policy is OFF/WARN).
      verificationPolicy,
      verificationBlockedRecipients: verificationBlockedCount,
      unverifiedRecipients: unverifiedCount,
      estimatedSeconds: queued * settings.minDelaySeconds,
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