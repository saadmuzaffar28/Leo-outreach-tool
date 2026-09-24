import { z } from "zod";

export const emailSchema = z.string().trim().email().toLowerCase();

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const templateSchema = z.object({
  name: z.string().trim().min(1, "Template name is required").max(120),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  body: z.string().trim().min(1, "Body is required").max(50_000),
  useSignature: z.boolean().optional(),
  signatureOverride: z.string().trim().max(5_000).optional(),
});

export const templateUpdateSchema = templateSchema.partial();

export const templateStatusSchema = z.object({
  isActive: z.boolean(),
});

export const templateTestSendSchema = z.object({
  to: emailSchema,
  template: z.object({
    subject: z.string().min(1, "Subject is required").max(200),
    body: z.string().min(1, "Body is required").max(50_000),
    useSignature: z.boolean().optional(),
    signatureOverride: z.string().trim().max(5_000).optional(),
  }),
});

export const campaignCreateSchema = z
  .object({
    name: z.string().trim().min(1, "Campaign name is required").max(120),
    templateId: z.string().min(1),
    googleAccountId: z.string().min(1, "Select the Gmail account to send from").optional(),
    microsoftAccountId: z
      .string()
      .min(1, "Select the Outlook account to send from")
      .optional(),
    smtpAccountId: z.string().min(1, "Select the SMTP account to send from").optional(),
  })
  .refine(
    (v) =>
      [Boolean(v.googleAccountId), Boolean(v.microsoftAccountId), Boolean(v.smtpAccountId)].filter(Boolean).length === 1,
    { message: "Select exactly one sending account — Gmail, Outlook, or SMTP" },
  );

export const campaignActionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "stop"]),
});

export const campaignUpdateSchema = z.object({
  templateId: z.string().min(1, "Template is required"),
});

export const suppressionCreateSchema = z.object({
  email: emailSchema,
  reason: z.string().trim().max(200).optional(),
});

export const accountSignatureSchema = z.object({
  signatureOverride: z.string().trim().max(5_000),
});

export const unsubscribeSchema = z.object({
  u: z.string().min(1),
  e: emailSchema,
  s: z.string().regex(/^[0-9a-f]{64}$/),
});

const boundedInt = (label: string, min: number, max: number) =>
  z.number().int().min(min, `${label} must be at least ${min}`).max(max, `${label} is too large`);

export const sendSettingsUpdateSchema = z.object({
  dailySendLimit: boundedInt("Daily send limit", 1, 10_000),
  messagesPerMinute: boundedInt("Messages per minute", 1, 60),
  minDelaySeconds: boundedInt("Minimum delay", 1, 3600),
  maxDelaySeconds: boundedInt("Maximum delay", 1, 24 * 3600),
  maxRetryAttempts: boundedInt("Max retry attempts", 0, 50),
  baseRetryDelaySeconds: boundedInt("Base retry delay", 1, 24 * 3600),
  maxRetryDelaySeconds: boundedInt("Max retry delay", 1, 7 * 24 * 3600),
  sendMode: z.enum(["live", "test"]),
});

export type CampaignAction = z.infer<typeof campaignActionSchema>["action"];

// ---------------------------------------------------------------------------
// SMS (8x8)
// ---------------------------------------------------------------------------

export const smsContactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{6,14}$/, "Phone number must be E.164 (e.g. +12025550123)"),
});

export const smsContactUpdateSchema = smsContactSchema.partial().extend({
  optOut: z.boolean().optional(),
});

export const smsCampaignCreateSchema = z.object({
  name: z.string().trim().min(1, "Campaign name is required").max(120),
  message: z.string().trim().min(1, "Message is required").max(1_600),
  source: z.string().trim().min(1, "Sending number is required").max(20),
  contactIds: z.array(z.string()).min(1, "Select at least one recipient"),
  sendNow: z.boolean(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
});

export const smsReplySchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{6,14}$/, "Phone number must be E.164"),
  message: z.string().trim().min(1, "Message is required").max(1_600),
});

export const smsTemplateSchema = z.object({
  name: z.string().trim().min(1, "Template name is required").max(120),
  message: z
    .string()
    .trim()
    .min(1, "Message is required")
    .max(1_600, "SMS messages are limited to 1600 characters"),
});

export const smsTemplateUpdateSchema = smsTemplateSchema.partial();