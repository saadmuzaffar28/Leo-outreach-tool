import { prisma } from "@/lib/prisma";
import { getX8Client, isX8Configured } from "./client";
import {
  X8ApiError,
  mapX8StateToStatus,
  type X8SendSmsResponse,
  type X8SendBatchResponse,
} from "./types";

export interface SendResult {
  messageId: string;
  x8MessageId: string | null;
  status: "sent" | "failed" | "queued";
  error?: string;
}

export interface CampaignSendSummary {
  total: number;
  sent: number;
  failed: number;
  skippedOptedOut: number;
  batchId: string | null;
}

/** E.164-ish validation: optional +, 7-15 digits. */
export function isValidPhoneNumber(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone.trim());
}

/** Normalize to E.164 (adds + when missing digits-only). */
export function normalizePhoneNumber(phone: string): string {
  const trimmed = phone.trim().replace(/[\s\-().]/g, "");
  if (/^\d+$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

/**
 * Send a single SMS through 8x8 and persist it in the Messages table.
 * In mock mode (no X8 credentials) the message is stored with a fake id.
 */
export async function sendSingleSms(params: {
  userId: string;
  contactId?: string | null;
  campaignId?: string | null;
  phoneNumber: string;
  message: string;
  source: string;
}): Promise<SendResult> {
  const phoneNumber = normalizePhoneNumber(params.phoneNumber);
  if (!isValidPhoneNumber(phoneNumber)) {
    return { messageId: "", x8MessageId: null, status: "failed", error: "Invalid phone number" };
  }

  const record = await prisma.message.create({
    data: {
      userId: params.userId,
      campaignId: params.campaignId ?? null,
      contactId: params.contactId ?? null,
      phoneNumber,
      message: params.message,
      direction: "outbound",
      status: "queued",
      source: params.source,
    },
  });

  if (!isX8Configured()) {
    // Mock mode — clearly marked so it can never be mistaken for a real send.
    await prisma.message.update({
      where: { id: record.id },
      data: {
        status: "sent",
        x8MessageId: `mock-${record.id}`,
        sentAt: new Date(),
      },
    });
    return { messageId: record.id, x8MessageId: `mock-${record.id}`, status: "sent" };
  }

  try {
    const client = getX8Client();
    const res: X8SendSmsResponse = await client.sendSms({
      destination: phoneNumber,
      source: params.source,
      text: params.message,
      clientMessageId: record.id,
    });
    const queued = res.status?.code === "QUEUED";
    await prisma.message.update({
      where: { id: record.id },
      data: {
        x8MessageId: res.umid,
        status: queued ? "sent" : "failed",
        sentAt: queued ? new Date() : null,
        failedAt: queued ? null : new Date(),
        lastError: queued ? null : res.status?.description ?? "Rejected by 8x8",
      },
    });
    return {
      messageId: record.id,
      x8MessageId: res.umid,
      status: queued ? "sent" : "failed",
      error: queued ? undefined : res.status?.description,
    };
  } catch (err) {
    const message = err instanceof X8ApiError ? err.message : "8x8 API request failed";
    await prisma.message.update({
      where: { id: record.id },
      data: { status: "failed", failedAt: new Date(), lastError: message },
    });
    return { messageId: record.id, x8MessageId: null, status: "failed", error: message };
  }
}

/**
 * Send a campaign via the 8x8 batch endpoint with per-recipient personalization.
 * Opted-out contacts are never sent to. Every message row is persisted before
 * the API call; after the call each row is linked to its 8x8 umid.
 */
export async function sendCampaignBatch(params: {
  userId: string;
  campaignId: string;
  source: string;
  messageTemplate: string;
  recipients: Array<{ contactId: string; phoneNumber: string; name?: string | null }>;
}): Promise<CampaignSendSummary> {
  const optedOut = await prisma.contact.findMany({
    where: { userId: params.userId, id: { in: params.recipients.map((r) => r.contactId) }, optOut: true },
    select: { id: true },
  });
  const optedOutIds = new Set(optedOut.map((c) => c.id));

  const eligible = params.recipients.filter((r) => !optedOutIds.has(r.contactId));
  const skippedOptedOut = params.recipients.length - eligible.length;

  // Persist all messages first (status queued) so nothing is lost on failure.
  const records = new Map<string, string>(); // contactId -> messageId
  for (const r of eligible) {
    const phone = normalizePhoneNumber(r.phoneNumber);
    const body = personalize(params.messageTemplate, r.name);
    const rec = await prisma.message.create({
      data: {
        userId: params.userId,
        campaignId: params.campaignId,
        contactId: r.contactId,
        phoneNumber: phone,
        message: body,
        direction: "outbound",
        status: "queued",
        source: params.source,
      },
    });
    records.set(r.contactId, rec.id);
  }

  if (!isX8Configured()) {
    // Mock mode: mark everything sent with mock ids.
    for (const [, messageId] of Array.from(records)) {
      await prisma.message.update({
        where: { id: messageId },
        data: { status: "sent", x8MessageId: `mock-${messageId}`, sentAt: new Date() },
      });
    }
    return {
      total: params.recipients.length,
      sent: eligible.length,
      failed: 0,
      skippedOptedOut,
      batchId: null,
    };
  }

  const client = getX8Client();
  try {
    const res: X8SendBatchResponse = await client.sendBatch({
      source: params.source,
      destinations: eligible.map((r) => ({
        destination: normalizePhoneNumber(r.phoneNumber),
        text: personalize(params.messageTemplate, r.name),
        clientMessageId: records.get(r.contactId),
      })),
      includeMessagesInResponse: true,
    });

    const byClientMessageId = new Map(
      (res.messages ?? []).map((m) => [m.clientMessageId ?? "", m]),
    );
    for (const [, messageId] of Array.from(records)) {
      const m = byClientMessageId.get(messageId);
      await prisma.message.update({
        where: { id: messageId },
        data: {
          x8MessageId: m?.umid ?? null,
          status: m ? "sent" : "failed",
          sentAt: m ? new Date() : null,
          failedAt: m ? null : new Date(),
          lastError: m ? null : "No umid returned for destination",
        },
      });
    }

    await prisma.smsCampaign.update({
      where: { id: params.campaignId },
      data: { x8BatchId: res.batchId },
    });

    return {
      total: params.recipients.length,
      sent: res.acceptedCount,
      failed: res.rejectedCount,
      skippedOptedOut,
      batchId: res.batchId,
    };
  } catch (err) {
    const message = err instanceof X8ApiError ? err.message : "8x8 API request failed";
    for (const [, messageId] of Array.from(records)) {
      await prisma.message.update({
        where: { id: messageId },
        data: { status: "failed", failedAt: new Date(), lastError: message },
      });
    }
    return {
      total: params.recipients.length,
      sent: 0,
      failed: records.size,
      skippedOptedOut,
      batchId: null,
    };
  }
}

/** Replace {{name}} style placeholders. */
export function personalize(template: string, name?: string | null): string {
  return template.replace(/\{\{\s*name\s*\}\}/gi, name?.trim() || "there");
}

/**
 * Apply a delivery receipt to a stored message. Idempotent: terminal states
 * are never overwritten by later events.
 */
export async function applyDeliveryReceipt(input: {
  x8MessageId: string;
  state: string;
  detail?: string;
  errorCode?: number;
  errorMessage?: string;
  timestamp?: string;
}): Promise<void> {
  const msg = await prisma.message.findFirst({ where: { x8MessageId: input.x8MessageId } });
  if (!msg) return;

  const status = mapX8StateToStatus(input.state);
  const ts = input.timestamp ? new Date(input.timestamp) : new Date();

  // Terminal states are final — ignore out-of-order duplicates.
  const terminal = new Set(["delivered", "failed", "undelivered", "rejected"]);
  if (terminal.has(msg.status)) return;

  const data: Record<string, unknown> = { status };
  if (status === "delivered") data.deliveredAt = ts;
  if (terminal.has(status)) data.failedAt = ts;
  if (input.errorMessage) data.lastError = `${input.errorCode ?? ""} ${input.errorMessage}`.trim();

  await prisma.message.update({ where: { id: msg.id }, data });
}
