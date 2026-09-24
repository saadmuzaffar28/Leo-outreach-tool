import { describe, it, expect } from "vitest";
import {
  parseWebhook,
  isDuplicateEvent,
  isOptOutKeyword,
  isTerminalStatus,
} from "@/lib/8x8/webhook";
import type { X8DeliveryReceiptPayload, X8InboundSmsPayload, X8WebhookEnvelope } from "@/lib/8x8/types";

const DLR_BODY: X8WebhookEnvelope<X8DeliveryReceiptPayload> = {
  namespace: "SMS",
  eventType: "outbound_message_status_changed",
  description: "SMS outbound message delivery receipt",
  payload: {
    umid: "9e09ac86-bd74-5465-851d-1eb5a5fdbb9a",
    batchId: "3e09ac86-bd74-5465-851d-1eb5a5fdbb9b",
    subAccountId: "SubAccount-1",
    source: "8x8",
    destination: "+12025550293",
    status: {
      state: "delivered",
      timestamp: "2016-01-01T00:00:00Z",
      errorCode: 0,
      errorMessage: "",
    },
    smsCount: 1,
  },
};

const INBOUND_BODY: X8WebhookEnvelope<X8InboundSmsPayload> = {
  namespace: "SMS",
  eventType: "inbound_message_received",
  description: "SMS inbound message",
  payload: {
    umid: "9e09ac86-bd74-5465-851d-1eb5a5fdbb9c",
    subAccountId: "SubAccount-1",
    timestamp: "2016-01-01T14:34:56.017Z",
    source: "+6581968289",
    destination: "+4534735477",
    body: "Test MO message",
    encoding: "GSM7",
    smsCount: 1,
  },
};

describe("parseWebhook — delivery receipts", () => {
  it("parses the documented DLR format", () => {
    const parsed = parseWebhook(DLR_BODY);
    expect(parsed?.kind).toBe("dlr");
    if (parsed?.kind === "dlr") {
      expect(parsed.umid).toBe("9e09ac86-bd74-5465-851d-1eb5a5fdbb9a");
      expect(parsed.payload.status.state).toBe("delivered");
      expect(parsed.payload.destination).toBe("+12025550293");
    }
  });

  it("parses failed/undelivered DLRs", () => {
    const body = structuredClone(DLR_BODY);
    body.payload.status = {
      state: "undelivered",
      detail: "rejected_by_operator",
      errorCode: 15,
      errorMessage: "Invalid destination",
      timestamp: "2016-01-01T00:00:00Z",
    };
    const parsed = parseWebhook(body);
    expect(parsed?.kind).toBe("dlr");
    if (parsed?.kind === "dlr") {
      expect(parsed.payload.status.state).toBe("undelivered");
      expect(parsed.payload.status.errorCode).toBe(15);
    }
  });
});

describe("parseWebhook — inbound SMS", () => {
  it("parses the documented inbound format", () => {
    const parsed = parseWebhook(INBOUND_BODY);
    expect(parsed?.kind).toBe("inbound");
    if (parsed?.kind === "inbound") {
      expect(parsed.payload.source).toBe("+6581968289");
      expect(parsed.payload.body).toBe("Test MO message");
    }
  });
});

describe("parseWebhook — rejects malformed payloads", () => {
  it("rejects null / non-object bodies", () => {
    expect(parseWebhook(null)).toBeNull();
    expect(parseWebhook("string")).toBeNull();
    expect(parseWebhook(42)).toBeNull();
  });

  it("rejects missing eventType or namespace", () => {
    expect(parseWebhook({ payload: {} })).toBeNull();
    expect(parseWebhook({ eventType: "inbound_message_received" })).toBeNull();
  });

  it("rejects non-SMS namespaces", () => {
    expect(parseWebhook({ ...INBOUND_BODY, namespace: "VOICE" })).toBeNull();
  });

  it("rejects DLRs without a status object", () => {
    const body = structuredClone(DLR_BODY);
    delete (body.payload as unknown as Record<string, unknown>).status;
    expect(parseWebhook(body)).toBeNull();
  });

  it("rejects inbound messages without body/source", () => {
    const body = structuredClone(INBOUND_BODY);
    delete (body.payload as unknown as Record<string, unknown>).body;
    expect(parseWebhook(body)).toBeNull();
  });

  it("classifies unknown event types for storage-only handling", () => {
    const parsed = parseWebhook({
      namespace: "SMS",
      eventType: "some_future_event",
      payload: { umid: "u-1" },
    });
    expect(parsed?.kind).toBe("unknown");
  });
});

describe("webhook idempotency", () => {
  it("flags previously processed events as duplicates", () => {
    expect(isDuplicateEvent(0)).toBe(false);
    expect(isDuplicateEvent(1)).toBe(true);
    expect(isDuplicateEvent(3)).toBe(true); // 8x8 retries: 1s/10s/30s/90s
  });
});

describe("opt-out keyword detection", () => {
  it("recognizes standard STOP keywords case-insensitively", () => {
    expect(isOptOutKeyword("STOP")).toBe(true);
    expect(isOptOutKeyword("stop")).toBe(true);
    expect(isOptOutKeyword("  unsubscribe  ")).toBe(true);
    expect(isOptOutKeyword("QUIT")).toBe(true);
    expect(isOptOutKeyword("END")).toBe(true);
    expect(isOptOutKeyword("CANCEL")).toBe(true);
  });

  it("does not treat normal replies as opt-outs", () => {
    expect(isOptOutKeyword("Thanks for the update")).toBe(false);
    expect(isOptOutKeyword("stopped by the office")).toBe(false);
    expect(isOptOutKeyword("")).toBe(false);
  });
});

describe("terminal DLR states", () => {
  it("prevents out-of-order overwrites", () => {
    expect(isTerminalStatus("delivered")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("undelivered")).toBe(true);
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("sent")).toBe(false);
    expect(isTerminalStatus("queued")).toBe(false);
  });
});
