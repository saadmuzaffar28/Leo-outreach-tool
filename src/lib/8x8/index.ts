export { X8Client, x8Client, getX8Client, isX8Configured } from "./client";
export {
  X8ApiError,
  mapX8StateToStatus,
  X8_EVENT_INBOUND,
  X8_EVENT_DLR,
} from "./types";
export type {
  X8SendSmsRequest,
  X8SendSmsResponse,
  X8SendBatchRequest,
  X8SendBatchResponse,
  X8BatchDestination,
  X8BatchMessageResult,
  X8DeliveryReceiptPayload,
  X8InboundSmsPayload,
  X8WebhookEnvelope,
  X8DlrStatus,
  SmsStatus,
} from "./types";
export {
  sendSingleSms,
  sendCampaignBatch,
  applyDeliveryReceipt,
  isValidPhoneNumber,
  normalizePhoneNumber,
  personalize,
} from "./sms";
export type { SendResult, CampaignSendSummary } from "./sms";
