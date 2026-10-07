import { prisma } from "@/lib/prisma";
import { env, POLL_INTERVAL_MS } from "@/lib/env";
import {
  decryptAccount,
  getAuthorizedOAuthClient,
  mergeStoredTokens,
  sendMessage,
  type DecryptedAccount,
  type GmailOAuthClient,
} from "@/lib/google";
import {
  decryptMicrosoftAccount,
  encryptMicrosoftTokens,
  getAuthorizedMicrosoft,
  sendMicrosoftMail,
  GRAPH_SENT_MARKER,
  type DecryptedMicrosoftAccount,
} from "@/lib/microsoft";
import type { MailMessage } from "@/lib/message";
import { buildRawMessage, htmlBody, plainBody } from "@/lib/message";
import { decryptSmtpCredentials, sendSmtpMail, smtpSenderName, summarizeSmtpSend, SmtpError, type SmtpSecurity } from "@/lib/smtp";
import { buildUnsubscribeUrl, isSuppressed } from "@/lib/suppression";
import { coercePolicy, decideGate } from "@/lib/verification/gate";
import { statusesFor } from "@/lib/verification/service";
import type { VerificationStatus } from "@/lib/verification/types";
import { personalize } from "@/lib/personalization";
import { resolveSignatureForSend } from "@/lib/signature";
import { fillSubject, pickRecipientSender } from "@/lib/campaigns";
import { campaignTemplateSource } from "@/lib/templates";
import { decideSendError, type RetryPolicy } from "@/lib/send-queue";
import { logSendFailure } from "@/lib/redact";
import {
  clearRateLimitState,
  getDailyCounter,
  incrementDailyCounter,
  isQuotaPaused,
  recordRateLimitHit,
  type SendProvider,
} from "@/lib/quota";
import { getSendSettings, type SendSettingsData } from "@/lib/settings";
import { SendRateLimiter, type SendRatePolicy } from "@/lib/rate-limiter";

let shuttingDown = false;

/** Lease length for an atomic recipient claim — covers a crashed worker. */
const CLAIM_LEASE_MS = 10 * 60 * 1000;

const limiter = new SendRateLimiter();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryPolicy(settings: SendSettingsData): RetryPolicy {
  return {
    maxRetryAttempts: settings.maxRetryAttempts,
    baseRetryDelaySeconds: settings.baseRetryDelaySeconds,
    maxRetryDelaySeconds: settings.maxRetryDelaySeconds,
  };
}

function ratePolicy(settings: SendSettingsData): SendRatePolicy {
  return {
    messagesPerMinute: settings.messagesPerMinute,
    minDelaySeconds: settings.minDelaySeconds,
  };
}

async function markRecipient(
  id: string,
  data: {
    status: string;
    lastError?: string | null;
    nextAttemptAt?: Date | null;
    sentAt?: Date;
    googleMessageId?: string;
    subject?: string;
    isTest?: boolean;
    attempts?: number;
  },
): Promise<void> {
  await prisma.campaignRecipient.update({ where: { id }, data });
}

/**
 * Atomically claims a recipient so only one worker send is possible.
 * Fails for rows already claimed by another worker (status "sending",
 * not yet past its lease) or already terminal.
 */
async function claimRecipient(id: string, attempts: number, now: Date): Promise<boolean> {
  const res = await prisma.campaignRecipient.updateMany({
    where: {
      id,
      OR: [{ status: "pending" }, { status: "sending", nextAttemptAt: { lte: now } }],
    },
    data: {
      status: "sending",
      attempts: attempts + 1,
      nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
    },
  });
  return res.count === 1;
}

/**
 * Where-clause selecting every campaign tied to a sending account, whether
 * through the legacy single-account columns (pre-feature campaigns) or through
 * the multi-mailbox selection join table. Used when an account must pause its
 * campaigns (daily limit, auth failure).
 */
function campaignAccountWhere(provider: SendProvider, accountId: string) {
  return provider === "smtp"
    ? {
        OR: [
          { smtpAccountId: accountId },
          { sendingAccounts: { some: { smtpAccountId: accountId } } },
        ],
      }
    : provider === "microsoft"
      ? { microsoftAccountId: accountId }
      : { googleAccountId: accountId };
}

async function pauseCampaignsOnAccount(provider: SendProvider, accountId: string, reason: string): Promise<void> {
  await prisma.campaign.updateMany({
    where: { ...campaignAccountWhere(provider, accountId), status: "active" },
    data: { status: "paused", pausedAt: new Date(), pausedReason: reason },
  });
}

interface SendAccount {
  id: string;
  quotaPausedUntil: Date | null;
  signatureOverride: string | null;
}

export async function processDueRecipients(): Promise<number> {
  const now = new Date();
  const due = await prisma.campaignRecipient.findMany({
    where: {
      campaign: { status: "active" },
      OR: [{ status: "pending" }, { status: "sending", nextAttemptAt: { lte: now } }],
    },
    include: {
      smtpAccount: true,
      campaign: { include: { googleAccount: true, microsoftAccount: true, smtpAccount: true, template: true } },
      lead: true,
    },
    // Ordering MUST be a total order.
    //
    // `createdAt` alone is NOT unique: every seed written by the same `start`
    // shares one timestamp to millisecond precision, and Postgres is then free
    // to return equal-key rows in ANY order -- it does not, and must not, be
    // relied upon to. With `take: 10` that non-determinism is not cosmetic: the
    // window is decided before anything is sent, so whichever 10 rows the
    // planner happened to pick win every tick and the rows *behind* them in the
    // tie can be starved indefinitely. That is exactly how a recipient was left
    // stuck in `sending` while the other 459 queued behind it all went out.
    //
    // `id` is a cuid: unique, immutable, and stable, so it is a correct
    // tie-breaker. `[{createdAt},{id}]` makes the selection reproducible and
    // matches the composite index in the migration added for it.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 10,
  });
  if (due.length === 0) return 0;

  // Settings + suppression lists are per-owner; cache within this tick.
  const settingsCache = new Map<string, SendSettingsData>();
  const suppressionCache = new Map<string, ReadonlySet<string>>();
  // Stored verification results for the gate — one lookup per address per tick.
  const verificationCache = new Map<string, Promise<VerificationStatus | null>>();
  const runningSent = new Map<string, number>();
  const runningLimits = new Map<string, number>();
  const runningProviders = new Map<string, SendProvider>();

  async function settingsFor(userId: string): Promise<SendSettingsData> {
    let s = settingsCache.get(userId);
    if (!s) {
      s = await getSendSettings(userId);
      settingsCache.set(userId, s);
    }
    return s;
  }

  async function suppressedFor(userId: string): Promise<ReadonlySet<string>> {
    let set = suppressionCache.get(userId);
    if (set === undefined) {
      const rows = await prisma.suppression.findMany({
        where: { userId },
        select: { email: true },
      });
      set = new Set(rows.map((r) => r.email.toLowerCase()));
      suppressionCache.set(userId, set);
    }
    return set;
  }

  /** Stored verification status for one address (null = never verified). */
  function storedVerificationStatus(userId: string, email: string): Promise<VerificationStatus | null> {
    const key = `${userId}|${email.trim().toLowerCase()}`;
    let pending = verificationCache.get(key);
    if (!pending) {
      pending = statusesFor(userId, [email])
        .then((m) => (m.get(email.trim().toLowerCase())?.status as VerificationStatus | undefined) ?? null)
        .catch(() => null);
      verificationCache.set(key, pending);
    }
    return pending;
  }

  async function todaySentFor(provider: SendProvider, accountId: string, userId: string): Promise<number> {
    let sent = runningSent.get(accountId);
    if (sent === undefined) {
      const c = await getDailyCounter(provider, accountId, userId);
      sent = c.messagesSent;
      runningSent.set(accountId, sent);
    }
    return sent;
  }

  let processed = 0;

  for (const rec of due) {
    // The recipient's FROZEN mailbox assignment — written once when the
    // campaign started — decides the sender. Retries and worker restarts keep
    // reading this same row, so a recipient can never silently switch
    // mailboxes. Campaigns created before multi-mailbox selection existed have
    // no per-recipient assignment and fall back to the campaign-level account
    // (Gmail, Outlook, or a single SMTP mailbox), exactly like before.
    const decided = pickRecipientSender({
      recipientSmtp: rec.smtpAccount,
      campaignSmtp: rec.campaign.smtpAccount,
      campaignMicrosoft: rec.campaign.microsoftAccount,
      campaignGoogle: rec.campaign.googleAccount,
    });
    if (!decided) {
      await markRecipient(rec.id, { status: "failed", lastError: "No sending account connected to this campaign" });
      processed++;
      continue;
    }
    const provider: SendProvider = decided.kind;
    const smtpAccount =
      provider === "smtp" ? (rec.smtpAccount ?? rec.campaign.smtpAccount) : null;
    const googleAccount = provider === "google" ? rec.campaign.googleAccount : null;
    const microsoftAccount = provider === "microsoft" ? rec.campaign.microsoftAccount : null;
    const rawAccount = smtpAccount ?? microsoftAccount ?? googleAccount;
    if (!rawAccount) {
      await markRecipient(rec.id, { status: "failed", lastError: "No sending account connected to this campaign" });
      processed++;
      continue;
    }
    const account: SendAccount = {
      id: rawAccount.id,
      quotaPausedUntil:
        provider === "smtp"
          ? null
          : (rawAccount as { quotaPausedUntil: Date | null }).quotaPausedUntil,
      signatureOverride:
        provider === "smtp"
          ? null
          : (rawAccount as { signatureOverride: string | null }).signatureOverride,
    };
    const settings = await settingsFor(rec.campaign.userId);

    // Account-level rate-limit backoff (persisted across restarts).
    if (isQuotaPaused(account.quotaPausedUntil)) {
      continue;
    }

    // Per-account rate limiter: messages/min + minimum delay.
    const policy = ratePolicy(settings);
    if (!limiter.canSend(account.id, policy)) {
      continue;
    }

    // Daily application limit, enforced against the persistent counter.
    const sentToday = await todaySentFor(provider, account.id, rec.campaign.userId);
    const dailyLimit = settings.dailySendLimit;
    runningLimits.set(account.id, dailyLimit);
    runningProviders.set(account.id, provider);
    if (sentToday >= dailyLimit) {
      await pauseCampaignsOnAccount(
        provider,
        account.id,
        `Daily application send limit reached (${sentToday}/${dailyLimit}). Resume after the daily window resets.`,
      );
      continue;
    }

    // Suppression list is checked immediately before every send attempt.
    // Safety rule: suppression ALWAYS wins — verification can never override
    // an unsubscribe, hard bounce, complaint, or manual block.
    const suppressed = await suppressedFor(rec.campaign.userId);
    if (isSuppressed(rec.recipient, suppressed)) {
      await markRecipient(rec.id, { status: "skipped", lastError: "Suppressed" });
      await incrementDailyCounter(provider, account.id, rec.campaign.userId, { kind: "skipped", count: 1 });
      processed++;
      continue;
    }

    // Campaign verification gate (policy OFF/WARN = no check at all). This
    // only reads STORED verification results — an expensive SMTP verification
    // never runs inside the send path (Phase 15). Skips are recorded, never
    // silent: lastError states the exact policy reason.
    const verificationPolicy = coercePolicy(rec.campaign.verificationPolicy);
    if (verificationPolicy !== "OFF" && verificationPolicy !== "WARN") {
      const storedStatus = await storedVerificationStatus(rec.campaign.userId, rec.recipient);
      const gate = decideGate(verificationPolicy, storedStatus);
      if (gate.block) {
        await markRecipient(rec.id, { status: "skipped", lastError: gate.reason });
        await incrementDailyCounter(provider, account.id, rec.campaign.userId, { kind: "skipped", count: 1 });
        processed++;
        continue;
      }
    }

    const tpl = campaignTemplateSource(rec.campaign);
    if (!tpl) {
      await markRecipient(rec.id, { status: "failed", lastError: "Email template missing" });
      processed++;
      continue;
    }

    // Atomic claim — prevents duplicate sends if two workers race, and lets
    // a crashed worker's claim be reclaimed after the lease expires.
    if (!(await claimRecipient(rec.id, rec.attempts, now))) {
      continue;
    }
    const attemptsUsed = rec.attempts + 1;

    const googleAccountData = provider === "google" ? decryptAccount(googleAccount!) : null;
    const microsoftAccountData = provider === "microsoft" ? decryptMicrosoftAccount(microsoftAccount!) : null;
    const values = {
      first_name: rec.lead?.firstName ?? "",
      last_name: rec.lead?.lastName ?? "",
      email: rec.recipient,
      practice_name: rec.lead?.practiceName ?? "",
    };
    const subject = fillSubject(tpl.subject, values);
    const body = personalize(tpl.body, values);

    // Signature: one shared resolution used by every sending path. Template
    // override wins, then the sending account's own rich signature (SMTP), then
    // the legacy account override, then the signature captured from Gmail. The
    // account attached to THIS campaign decides — so if a campaign is re-pointed
    // at a different mailbox, that mailbox's signature is what ships.
    const signatureHtml = resolveSignatureForSend({
      templateUseSignature: tpl.useSignature,
      templateOverride: tpl.signatureOverride || null,
      accountSignatureEnabled: provider === "smtp" ? Boolean(smtpAccount?.signatureEnabled) : false,
      accountSignatureHtml: provider === "smtp" ? smtpAccount?.signatureHtml ?? null : null,
      accountOverride: account.signatureOverride,
      gmailSignature: provider === "google" ? googleAccountData?.signature ?? null : null,
    });

    const fromEmail =
      provider === "smtp"
        ? smtpAccount!.email
        : provider === "microsoft"
          ? microsoftAccountData!.microsoftEmail
          : googleAccountData!.googleEmail;

    // The From NAME is decided by the same account that is sending:
    //   - SMTP  -> the per-mailbox display name (fallback: the email's local
    //              part, e.g. lucas@ -> Lucas). Never the campaign name, the
    //              campaign creator's name, or a global SENDER_NAME — the
    //              recipient's From must match the mailbox that actually
    //              authenticates the send, together with its signature.
    //   - Gmail / Outlook -> the campaign-level display name (falling back to
    //              the global SENDER_NAME), unchanged from before this feature.
    // The From ADDRESS is always the selected account's own address below, so a
    // display name can never spoof a different sender address.
    const fromName =
      provider === "smtp"
        ? smtpSenderName(smtpAccount!)
        : rec.campaign.senderName?.trim() || env.SENDER_NAME;

    const message: MailMessage = {
      fromName,
      fromEmail,
      to: rec.recipient,
      subject,
      body,
      unsubscribeUrl: buildUnsubscribeUrl(rec.campaign.userId, rec.recipient),
      signatureHtml,
    };

    // Test mode: process the queue exactly like live, but never call the provider.
    if (settings.sendMode === "test") {
      const decoded = Buffer.from(buildRawMessage(message), "base64url").toString("utf8");
      console.log(
        `[test] simulated send to ${rec.recipient} — subject "${subject}"\n${decoded}`,
      );
      await markRecipient(rec.id, {
        status: "sent",
        subject,
        sentAt: new Date(),
        googleMessageId: "simulated",
        lastError: null,
        nextAttemptAt: null,
        isTest: true,
      });
      limiter.recordSend(account.id);
      runningSent.set(account.id, (runningSent.get(account.id) ?? sentToday) + 1);
      await incrementDailyCounter(provider, account.id, rec.campaign.userId, { kind: "sent", count: 1 });
      processed++;
      continue;
    }

    let oauth: GmailOAuthClient | null = null;
    let microsoftAccessToken: string | null = null;
    // SMTP authenticates with its own stored username/password — no OAuth step.
    if (provider !== "smtp") {
      try {
        if (provider === "microsoft") {
          const { accessToken, refreshedTokens } = await getAuthorizedMicrosoft(microsoftAccountData!);
          microsoftAccessToken = accessToken;
          if (refreshedTokens) {
            await prisma.microsoftAccount.update({
              where: { id: account.id },
              data: encryptMicrosoftTokens(refreshedTokens),
            });
          }
        } else {
          const { client, refreshedTokens } = await getAuthorizedOAuthClient(googleAccountData!);
          oauth = client;
          if (refreshedTokens) {
            await prisma.googleAccount.update({
              where: { id: account.id },
              data: {
                // Google's token endpoint returns no refresh_token on refresh,
                // so this must be merged, never overwritten -- otherwise the
                // first send after expiry would erase the offline grant and the
                // account could never refresh again.
                ...mergeStoredTokens(refreshedTokens, {
                  refreshTokenEncrypted: googleAccount!.refreshTokenEncrypted,
                }),
                // A successful refresh proves the grant still works.
                status: "connected",
                statusMessage: null,
              },
            });
          }
        }
      } catch (err) {
        await handleError(provider, rec.campaign.id, rec.id, account.id, rec.campaign.userId, err, attemptsUsed, settings);
        processed++;
        continue;
      }
    }

    try {
      if (provider === "microsoft") {
        // For "shared" connect-mode accounts the stored sendFromEmail is passed
        // as a message-level FROM override (delegated Mail.Send.Shared). It is
        // purely a send-side override and is NEVER used to authenticate.
        const sendFromEmail = microsoftAccount?.sendFromEmail?.trim() || undefined;
        await sendMicrosoftMail(microsoftAccessToken!, message, sendFromEmail ? { sendFromEmail } : undefined);
        await markRecipient(rec.id, {
          status: "sent",
          subject,
          sentAt: new Date(),
          googleMessageId: GRAPH_SENT_MARKER,
          lastError: null,
          nextAttemptAt: null,
        });
      } else if (provider === "smtp") {
        // Decrypt the SMTP credentials in memory, immediately before sending.
        // The password is never stored on the message, never logged, and never
        // returned by any API.
        const dec = decryptSmtpCredentials({
          usernameEncrypted: smtpAccount!.usernameEncrypted,
          passwordEncrypted: smtpAccount!.passwordEncrypted,
        });
        const sendResult = await sendSmtpMail(
          {
            email: smtpAccount!.email,
            host: smtpAccount!.host,
            port: smtpAccount!.port,
            security: smtpAccount!.security as SmtpSecurity,
            username: dec.username,
            password: dec.password,
          },
          {
            to: message.to,
            subject,
            html: htmlBody(message),
            text: plainBody(message),
            fromName: message.fromName,
          },
        );
        // Record what the server said, not merely that we did not throw.
        //
        // `googleMessageId` is the schema's single provider-identifier column
        // and is already used provider-agnostically — the Microsoft branch
        // above writes GRAPH_SENT_MARKER into it. Persisting the SMTP
        // Message-ID there gives an SMTP send the same forensic value a Gmail
        // send has always had: a string that can be matched against the
        // receiving server's logs to settle whether a message actually left.
        //
        // summarizeSmtpSend keeps the identifier and turns the address lists
        // into counts. The raw `response` is dropped: SMTP servers quote
        // credentials back in their replies (see classifySmtpError).
        const sendSummary = summarizeSmtpSend(sendResult);

        // nodemailer RESOLVES when the server accepts the DATA transaction even
        // if it refused the envelope recipient. Recording that as `sent` would
        // mark a prospect as delivered who was never accepted — a silent data
        // corruption that no later assertion would catch. Retrying cannot help
        // (the address itself was refused), so this is classified permanent.
        if (sendSummary.rejectedCount > 0) {
          throw new SmtpError(
            "INVALID_CONFIG",
            `SMTP server rejected ${sendSummary.rejectedCount} envelope recipient(s) for this message`,
          );
        }

        await markRecipient(rec.id, {
          status: "sent",
          subject,
          sentAt: new Date(),
          ...(sendSummary.messageId ? { googleMessageId: sendSummary.messageId } : {}),
          lastError: null,
          nextAttemptAt: null,
        });
      } else {
        const { messageId } = await sendMessage(oauth!, message);
        await markRecipient(rec.id, {
          status: "sent",
          subject,
          sentAt: new Date(),
          googleMessageId: messageId,
          lastError: null,
          nextAttemptAt: null,
        });
      }
      await Promise.all([
        clearRateLimitState(provider, account.id),
        incrementDailyCounter(provider, account.id, rec.campaign.userId, { kind: "sent", count: 1 }),
      ]);
      limiter.recordSend(account.id);
      runningSent.set(account.id, (runningSent.get(account.id) ?? sentToday) + 1);
      processed++;
    } catch (err) {
      await handleError(provider, rec.campaign.id, rec.id, account.id, rec.campaign.userId, err, attemptsUsed, settings);
      processed++;
    }
  }

  // Budget overflow cleanup — if any account crossed/equaled its limit this
  // tick, pause its active campaigns so remaining sends stop.
  for (const [accountId, limit] of Array.from(runningLimits.entries())) {
    const sent = runningSent.get(accountId) ?? 0;
    if (sent >= limit) {
      await pauseCampaignsOnAccount(
        runningProviders.get(accountId) ?? "google",
        accountId,
        `Daily application send limit reached (${sent}/${limit}). Resume after the daily window resets.`,
      );
    }
  }

  return processed;
}

/**
 * Single entry point for every send failure.
 *
 * Emits exactly one structured log line per failure (see `logSendFailure`).
 * Before this existed, `schedule_retry` and `fail_permanent` wrote NOTHING:
 * the recipient row was updated and the reason was lost unless someone went
 * looking for it. `lastError` alone cannot answer "how many attempts has this
 * had" or "which campaign was it", which is exactly what is needed to tell an
 * exhausted retry budget from a stalled queue.
 */
async function handleError(
  provider: SendProvider,
  campaignId: string,
  recipientId: string,
  accountId: string,
  userId: string,
  err: unknown,
  attemptsUsed: number,
  settings: SendSettingsData,
): Promise<void> {
  const decision = decideSendError(err, attemptsUsed, retryPolicy(settings));

  // Log BEFORE mutating state, and exactly once, on every branch below.
  logSendFailure({
    campaignId,
    recipientId,
    provider,
    accountId,
    attempt: attemptsUsed,
    kind: decision.kind,
    action: decision.action,
    retryAfterSeconds:
      "retryAfterSeconds" in decision ? decision.retryAfterSeconds : null,
    detail: decision.message,
  });

  if (decision.action === "auth_required") {
    await markRecipient(recipientId, { status: "failed", lastError: decision.message, nextAttemptAt: null });
    // Flag ONLY this account as needing reauthorization, so one revoked grant
    // does not put every other connected Gmail account into the same state.
    if (provider === "google") {
      await prisma.googleAccount.updateMany({
        where: { id: accountId, status: { not: "reauth_required" } },
        data: { status: "reauth_required", statusMessage: decision.message },
      });
    }
    await prisma.campaign.updateMany({
      where: { ...campaignAccountWhere(provider, accountId), status: "active" },
      data: {
        status: "paused",
        pausedAt: new Date(),
        pausedReason: `${decision.message}. Reconnect the sending account, then resume the campaign.`,
      },
    });
    await incrementDailyCounter(provider, accountId, userId, { kind: "failed", count: 1 });
    return;
  }

  if (decision.action === "quota_backoff") {
    const pausedMs = await recordRateLimitHit(provider, accountId, decision.retryAfterSeconds, decision.message);
    await markRecipient(recipientId, {
      status: "sending",
      attempts: attemptsUsed,
      lastError: decision.message,
      nextAttemptAt: new Date(Date.now() + Math.max(decision.retryAfterSeconds * 1000, pausedMs)),
    });
    return;
  }

  // schedule_retry or fail_permanent
  const failed = decision.action === "fail_permanent";
  await markRecipient(recipientId, {
    status: failed ? "failed" : "sending",
    attempts: attemptsUsed,
    lastError: decision.message,
    nextAttemptAt: failed ? null : new Date(Date.now() + decision.retryAfterSeconds * 1000),
  });
  if (failed) {
    await incrementDailyCounter(provider, accountId, userId, { kind: "failed", count: 1 });
  }
}

/** Marks campaigns completed when every recipient is terminal. */
export async function markCompletedCampaigns(): Promise<string[]> {
  const active = await prisma.campaign.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  const completed: string[] = [];
  for (const campaign of active) {
    const remaining = await prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, status: { in: ["pending", "sending"] } },
    });
    if (remaining === 0) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "completed", completedAt: new Date() },
      });
      completed.push(campaign.id);
    }
  }
  return completed;
}

export async function runWorker(): Promise<void> {
  console.log("[worker] starting — polling every %ds", env.POLL_INTERVAL_SECONDS);

  process.on("SIGINT", () => {
    shuttingDown = true;
    console.log("[worker] stopping…");
    setTimeout(() => process.exit(0), 500).unref();
  });
  process.on("SIGTERM", () => {
    shuttingDown = true;
    console.log("[worker] stopping…");
    setTimeout(() => process.exit(0), 500).unref();
  });

  while (!shuttingDown) {
    try {
      const processed = await processDueRecipients();
      const completed = await markCompletedCampaigns();
      if (processed > 0) console.log(`[worker] processed ${processed} recipient(s)`);
      for (const id of completed) console.log(`[worker] campaign ${id} completed`);
    } catch (err) {
      console.error("[worker] tick failed", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}