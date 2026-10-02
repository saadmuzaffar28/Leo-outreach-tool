import {
  X8_EVENT_DLR,
  X8_EVENT_INBOUND,
  type X8DeliveryReceiptPayload,
  type X8InboundSmsPayload,
  type X8WebhookEnvelope,
} from "./types";

export type ParsedWebhook =
  | { kind: "dlr"; umid: string; payload: X8DeliveryReceiptPayload }
  | { kind: "inbound"; umid: string; payload: X8InboundSmsPayload }
  | { kind: "unknown"; eventType: string; umid: string | null };

/** Keywords that mark an inbound SMS as an opt-out request. */
export const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(text.trim().toUpperCase());
}

/**
 * Validates and classifies a raw webhook body per the official 8x8 formats:
 * - Delivery receipts: namespace SMS, eventType outbound_message_status_changed
 * - Inbound SMS:       namespace SMS, eventType inbound_message_received
 * Returns null when the body is not a recognizable 8x8 SMS webhook.
 */
export function parseWebhook(body: unknown): ParsedWebhook | null {
  if (!body || typeof body !== "object") return null;
  const env = body as Partial<X8WebhookEnvelope>;
  if (typeof env.eventType !== "string" || typeof env.namespace !== "string") return null;
  if (env.namespace.toUpperCase() !== "SMS") return null;

  const payload = env.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;
  const umid = typeof payload.umid === "string" ? payload.umid : null;

  if (env.eventType === X8_EVENT_DLR) {
    const p = payload as unknown as X8DeliveryReceiptPayload;
    if (!umid || !p.status || typeof p.status.state !== "string") return null;
    if (typeof p.destination !== "string") return null;
    return { kind: "dlr", umid, payload: p };
  }

  if (env.eventType === X8_EVENT_INBOUND) {
    const p = payload as unknown as X8InboundSmsPayload;
    if (!umid || typeof p.source !== "string" || typeof p.body !== "string") return null;
    return { kind: "inbound", umid, payload: p };
  }

  return { kind: "unknown", eventType: env.eventType, umid };
}

/**
 * Idempotency: 8x8 retries webhooks on failure (1s/10s/30s/90s). A duplicate
 * delivery of the same event must not create a second reply or re-apply a DLR.
 */
export function isDuplicateEvent(
  existingProcessedCount: number,
): boolean {
  return existingProcessedCount > 0;
}

/** Terminal message states that later (out-of-order) DLRs cannot override. */
export const TERMINAL_STATES = new Set(["delivered", "failed", "undelivered", "rejected"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATES.has(status);
}
