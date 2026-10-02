import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { jsonResponse, badRequest } from "@/lib/http";
import {
  parseWebhook,
  isDuplicateEvent,
  isTerminalStatus,
  isOptOutKeyword,
} from "@/lib/8x8/webhook";

/**
 * 8x8 SMS webhook receiver.
 *
 * Handles delivery receipts (outbound_message_status_changed) and inbound SMS
 * (inbound_message_received). Every raw payload is stored for auditing;
 * processing is idempotent so 8x8 retries (1s/10s/30s/90s) cannot create
 * duplicate replies or overwrite terminal statuses.
 */
export async function POST(req: Request) {
  // Validate per 8x8 docs: the portal lets you set an HTTP Authorization
  // string that 8x8 includes verbatim on every webhook call.
  if (env.X8_WEBHOOK_AUTH) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== env.X8_WEBHOOK_AUTH) {
      return jsonResponse({ error: "Invalid webhook authorization" }, 401);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const parsed = parseWebhook(body);
  if (!parsed) return badRequest("Unrecognized webhook payload");

  // Idempotency guard: skip if this exact event was already processed.
  if (parsed.umid) {
    const existing = await prisma.webhookEvent.count({
      where: { eventType: eventTypeFor(parsed), x8MessageId: parsed.umid, processed: true },
    });
    if (isDuplicateEvent(existing)) {
      return jsonResponse({ ok: true, duplicate: true });
    }
  }

  const event = await prisma.webhookEvent.create({
    data: {
      eventType: parsed.kind === "unknown" ? parsed.eventType : eventTypeFor(parsed),
      x8MessageId: parsed.umid,
      payload: body as object,
      processed: false,
    },
  });

  try {
    if (parsed.kind === "dlr") {
      await processDeliveryReceipt(event.id, parsed.payload);
    } else if (parsed.kind === "inbound") {
      await processInboundSms(event.id, parsed.payload);
    }
    // Unknown event types are stored but left unprocessed — still ACKed so
    // 8x8 does not retry indefinitely.
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processed: true } });
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { error: err instanceof Error ? err.message : "processing failed" },
    });
    // Return 500 so 8x8 retries later.
    return jsonResponse({ error: "Webhook processing failed" }, 500);
  }

  return jsonResponse({ ok: true });
}

function eventTypeFor(parsed: ReturnType<typeof parseWebhook> & object): string {
  return parsed.kind === "dlr"
    ? "outbound_message_status_changed"
    : parsed.kind === "inbound"
      ? "inbound_message_received"
      : (parsed as { eventType: string }).eventType;
}

async function processDeliveryReceipt(
  eventId: string,
  p: import("@/lib/8x8/types").X8DeliveryReceiptPayload,
) {
  const msg = await prisma.message.findFirst({ where: { x8MessageId: p.umid } });

  const state = p.status.state.toLowerCase();
  const ts = p.status.timestamp ? new Date(p.status.timestamp) : new Date();

  if (msg && !isTerminalStatus(msg.status)) {
    const status =
      state === "delivered"
        ? "delivered"
        : state === "undelivered"
          ? "undelivered"
          : state === "rejected"
            ? "rejected"
            : state === "queued" || state === "accepted"
              ? "queued"
              : state === "sent"
                ? "sent"
                : "failed";
    const data: Record<string, unknown> = { status };
    if (status === "delivered") data.deliveredAt = ts;
    if (isTerminalStatus(status)) data.failedAt = ts;
    if (p.status.errorMessage) {
      data.lastError = `${p.status.errorCode ?? ""} ${p.status.errorMessage}`.trim();
    }
    await prisma.message.update({ where: { id: msg.id }, data });
  }

  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { messageId: msg?.id ?? null },
  });
}

async function processInboundSms(
  eventId: string,
  p: import("@/lib/8x8/types").X8InboundSmsPayload,
) {
  // Find the most recent outbound message to this number for threading.
  const lastOutbound = await prisma.message.findFirst({
    where: { phoneNumber: p.source, direction: "outbound" },
    orderBy: { createdAt: "desc" },
  });

  // Attribute to the outbound sender; single-tenant fallback to first user.
  let userId = lastOutbound?.userId ?? null;
  if (!userId) {
    const anyUser = await prisma.user.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    userId = anyUser?.id ?? null;
  }
  if (!userId) throw new Error("No user exists to attribute inbound SMS");

  const contact = await prisma.contact.findFirst({
    where: { phoneNumber: p.source, ...(lastOutbound ? { userId } : {}) },
  });

  // Opt-out handling: STOP-style replies set optOut permanently.
  if (contact && isOptOutKeyword(p.body)) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { optOut: true, status: "opted_out" },
    });
  }

  const receivedAt = p.timestamp ? new Date(p.timestamp) : new Date();

  await prisma.reply.create({
    data: {
      userId,
      messageId: lastOutbound?.id ?? null,
      campaignId: lastOutbound?.campaignId ?? null,
      contactId: contact?.id ?? null,
      phoneNumber: p.source,
      message: p.body,
      receivedAt,
    },
  });

  // Also record it as an inbound Message so conversations show both sides.
  await prisma.message.create({
    data: {
      userId,
      campaignId: lastOutbound?.campaignId ?? null,
      contactId: contact?.id ?? null,
      x8MessageId: p.umid,
      phoneNumber: p.source,
      message: p.body,
      direction: "inbound",
      status: "received",
      source: p.destination,
      createdAt: receivedAt,
    },
  });

  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { messageId: lastOutbound?.id ?? null },
  });
}
