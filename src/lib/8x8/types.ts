/**
 * 8x8 Connect SMS API types.
 * Verified against https://developer.8x8.com/connect/reference/sms-api/
 */

/** Single SMS send request body (POST /api/v1/subaccounts/{subAccountId}/messages) */
export interface X8SendSmsRequest {
  /** Destination phone number in E.164 format */
  destination: string;
  /** Source address (sender ID or virtual number) */
  source: string;
  /** Message text */
  text: string;
  /** Optional client-managed message id echoed back in DLRs */
  clientMessageId?: string;
  /** Optional scheduled send time (ISO 8601) */
  schedulingTime?: string;
  /** Optional message expiry time (ISO 8601) */
  expiryTime?: string;
  /** Optional per-message delivery receipt callback override */
  dlrCallbackUrl?: string;
  /** Encoding: AUTO (default), GSM7 or UCS2 */
  encoding?: "AUTO" | "GSM7" | "UCS2";
}

/** Response for single SMS send */
export interface X8SendSmsResponse {
  umid: string;
  clientMessageId?: string;
  destination: string;
  encoding?: "GSM7" | "UCS2";
  status: {
    code: "QUEUED" | "REJECTED";
    description: string;
  };
}

/** One destination inside a batch request */
export interface X8BatchDestination {
  destination: string;
  /** Optional per-recipient personalized text */
  text?: string;
  clientMessageId?: string;
}

/** Batch SMS send request body (POST /api/v1/subaccounts/{subAccountId}/messages/batch) */
export interface X8SendBatchRequest {
  /** Shared default text when destinations do not personalize */
  text?: string;
  source: string;
  destinations: X8BatchDestination[];
  clientBatchId?: string;
  schedulingTime?: string;
  expiryTime?: string;
  dlrCallbackUrl?: string;
  encoding?: "AUTO" | "GSM7" | "UCS2";
  includeMessagesInResponse?: boolean;
}

export interface X8BatchMessageResult {
  umid: string;
  clientMessageId?: string;
  destination: string;
  encoding?: "GSM7" | "UCS2";
}

/** Response for batch SMS send */
export interface X8SendBatchResponse {
  batchId: string;
  clientBatchId?: string;
  acceptedCount: number;
  rejectedCount: number;
  messages?: X8BatchMessageResult[];
  status: {
    code: "QUEUED" | "REJECTED";
    description: string;
  };
}

/** Status object inside delivery receipts */
export interface X8DlrStatus {
  state:
    | "queued"
    | "accepted"
    | "sent"
    | "delivered"
    | "undelivered"
    | "rejected"
    | "expired"
    | "deleted"
    | "unknown";
  detail?: string;
  timestamp?: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface X8PriceObject {
  total?: number;
  perSms?: number;
  currency?: string;
}

/** Delivery receipt webhook payload (eventType: outbound_message_status_changed) */
export interface X8DeliveryReceiptPayload {
  umid: string;
  batchId?: string;
  clientMessageId?: string;
  clientBatchId?: string;
  subAccountId?: string;
  source?: string;
  destination: string;
  status: X8DlrStatus;
  price?: X8PriceObject;
  smsCount?: number;
}

/** Inbound SMS webhook payload (eventType: inbound_message_received) */
export interface X8InboundSmsPayload {
  umid: string;
  subAccountId?: string;
  timestamp: string;
  source: string;
  destination: string;
  body: string;
  encoding?: "GSM7" | "UCS2";
  smsCount?: number;
  price?: X8PriceObject;
}

/** Envelope shared by all 8x8 SMS webhooks */
export interface X8WebhookEnvelope<T = unknown> {
  namespace: string;
  eventType: string;
  description?: string;
  payload: T;
}

export const X8_EVENT_INBOUND = "inbound_message_received" as const;
export const X8_EVENT_DLR = "outbound_message_status_changed" as const;

/** Normalized message states used by our application */
export type SmsStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "rejected";

/** Map an 8x8 DLR state to our internal SmsStatus */
export function mapX8StateToStatus(state: string): SmsStatus {
  switch (state.toLowerCase()) {
    case "delivered":
      return "delivered";
    case "undelivered":
      return "undelivered";
    case "rejected":
      return "rejected";
    case "expired":
    case "deleted":
      return "failed";
    case "queued":
    case "accepted":
      return "queued";
    case "sent":
      return "sent";
    default:
      return "sent";
  }
}

/** Error thrown by the 8x8 client on non-2xx responses or network failures */
export class X8ApiError extends Error {
  readonly statusCode?: number;
  readonly apiErrorCode?: string | number;
  readonly responseBody?: string;

  constructor(
    message: string,
    options?: { statusCode?: number; apiErrorCode?: string | number; responseBody?: string },
  ) {
    super(message);
    this.name = "X8ApiError";
    this.statusCode = options?.statusCode;
    this.apiErrorCode = options?.apiErrorCode;
    this.responseBody = options?.responseBody;
  }
}
