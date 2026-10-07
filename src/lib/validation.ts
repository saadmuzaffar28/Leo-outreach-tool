import { z } from "zod";

export const smtpSignatureUpdateSchema = z
  .object({
    signatureEnabled: z.boolean().optional(),
    signatureHtml: z.string().max(20_000).optional(),
  })
  .refine(
    (v) => v.signatureEnabled !== undefined || v.signatureHtml !== undefined,
    { message: "Nothing to update" },
  );

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
    // Per-campaign sender display name. Optional: when absent the worker falls
    // back to the global SENDER_NAME env value, so campaigns created before this
    // field existed keep their previous behaviour.
    //
    // CR/LF are rejected outright rather than sanitised: they have no legitimate
    // use in a display name and are the classic header-injection payload. Angle
    // brackets are rejected too so the value cannot break out of the "Name <addr>"
    // form and forge a different sender address. message.encodeHeaderValue also
    // neutralises CR/LF as defence in depth for callers outside this schema.
    senderName: z
      .string()
      .trim()
      .min(1, "Sender name cannot be blank")
      .max(80, "Sender name must be 80 characters or fewer")
      .refine((v) => !/[\r\n]/.test(v), "Sender name cannot contain line breaks")
      .refine((v) => !/[<>]/.test(v), "Sender name cannot contain < or >")
      .optional(),
    // Optional audience segment. Absent = every lead (pre-Groups behaviour).
    recipientGroupId: z.string().min(1).optional(),
    googleAccountId: z.string().min(1, "Select the Gmail account to send from").optional(),
    microsoftAccountId: z
      .string()
      .min(1, "Select the Outlook account to send from")
      .optional(),
    // Legacy single-SMTP field, kept for backward compatibility with callers
    // that send `smtpAccountId`. Treated as a one-element `smtpAccountIds`.
    smtpAccountId: z.string().min(1, "Select the SMTP account to send from").optional(),
    // Multi-mailbox selection (1..N connected SMTP mailboxes). Safe with an
    // email address / mailbox id: ids are opaque, never credentials.
    smtpAccountIds: z
      .array(z.string().min(1, "Mailbox id cannot be empty"))
      .max(100, "Too many mailboxes")
      .optional(),
    // Email verification send-gate. Defaults to OFF when absent, so callers
    // that never heard of verification behave exactly as before (Phase 13).
    verificationPolicy: z
      .enum(["OFF", "WARN", "BLOCK_INVALID", "BLOCK_INVALID_AND_RISKY"])
      .optional(),
  })
  .superRefine((v, ctx) => {
    const smtpCount = (v.smtpAccountIds ?? (v.smtpAccountId ? [v.smtpAccountId] : [])).length;
    const googleCount = v.googleAccountId ? 1 : 0;
    const microsoftCount = v.microsoftAccountId ? 1 : 0;
    if (smtpCount > 0 && (googleCount > 0 || microsoftCount > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select SMTP mailboxes OR a Gmail/Outlook account — not both",
      });
      return;
    }
    if (smtpCount === 0 && googleCount + microsoftCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: googleCount + microsoftCount > 1
          ? "Select exactly one sending account — Gmail, Outlook, or SMTP"
          : "Select at least one sending mailbox",
      });
    }
  });

export const campaignActionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "stop"]),
});

export const campaignUpdateSchema = z
  .object({
    templateId: z.string().min(1, "Template is required").optional(),
    // Replace the campaign's sending-mailbox selection (1..N connected
    // mailboxes). Only honoured before the campaign starts; already-sent or
    // already-attempted recipients keep their frozen assignment.
    smtpAccountIds: z
      .array(z.string().min(1, "Mailbox id cannot be empty"))
      .min(1, "Select at least one sending mailbox")
      .max(100, "Too many mailboxes")
      .optional(),
    verificationPolicy: z
      .enum(["OFF", "WARN", "BLOCK_INVALID", "BLOCK_INVALID_AND_RISKY"])
      .optional(),
  })
  .refine(
    (v) =>
      v.templateId !== undefined ||
      v.smtpAccountIds !== undefined ||
      v.verificationPolicy !== undefined,
    { message: "Nothing to update" },
  );

export const suppressionCreateSchema = z.object({
  email: emailSchema,
  reason: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Email verification (self-hosted AfterShip engine)
// ---------------------------------------------------------------------------

const verificationPolicyEnum = ["OFF", "WARN", "BLOCK_INVALID", "BLOCK_INVALID_AND_RISKY"] as const;

export { verificationPolicyEnum };

/** POST /api/email-verification/verify — one address, synchronous. */
export const verificationVerifySchema = z.object({
  email: z.string().trim().min(1, "Email is required").max(320),
  // Bypasses the cache and forces a fresh engine run.
  force: z.boolean().optional(),
});

/** POST /api/email-verification/bulk — queue background jobs. */
export const verificationBulkSchema = z
  .object({
    emails: z.array(z.string().max(320)).max(10_000, "Too many emails per request (max 10,000)").optional(),
    csv: z.string().min(1, "CSV content is missing").max(5_000_000, "CSV is too large (max 5MB)").optional(),
    force: z.boolean().optional(),
  })
  .refine((v) => v.emails !== undefined || v.csv !== undefined, {
    message: "Provide emails or CSV content",
  });

/** POST /api/email-verification/batches — "Verify File" (Phase 2). */
export const verificationBatchCreateSchema = z.object({
  filename: z.string().trim().min(1, "Filename is required").max(255),
  // Already-parsed addresses from the upload step — never the raw file.
  emails: z
    .array(z.string().max(320))
    .min(1, "No valid addresses to verify")
    .max(10_000, "Too many emails per batch (max 10,000)"),
  force: z.boolean().optional(),
});

/** GET /api/email-verification/list — filters for the bulk UI. */
export const verificationListQuerySchema = z.object({
  status: z.enum(["VALID", "INVALID", "CATCH_ALL", "RISKY", "UNKNOWN"]).optional(),
  q: z.string().trim().max(320).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const accountSignatureSchema = z.object({
  signatureOverride: z.string().trim().max(5_000),
});

// ---------------------------------------------------------------------------
// Contact groups
// ---------------------------------------------------------------------------

// GROUP_NAME_MAX is enforced in the route so the message can name the constant,
// but the schema still caps it so an oversized name never reaches Prisma.
export const groupCreateSchema = z.object({
  name: z.string().trim().min(1, "Group name is required").max(120),
  description: z.string().trim().max(500).optional(),
});

export const groupUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Group name is required").max(120).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: "Nothing to update",
  });

export const groupMembersSchema = z.object({
  leadIds: z.array(z.string()).min(1, "Select at least one contact").max(5_000),
});

export const removeGroupMemberSchema = z.object({
  leadId: z.string().min(1),
});

/**
 * CSV import save. The destination group can be given three ways so the UI can
 * offer "create new" and "add to existing" without extra round trips:
 *  - groupId              -> attach to that group
 *  - groupName            -> create a new group with that name
 *  - neither              -> ungrouped import (current behaviour, still valid)
 */
export const leadImportSaveSchema = z.object({
  csv: z.string().min(1, "CSV content is missing").max(5_000_000, "CSV is too large (max 5MB)"),
  groupId: z.string().min(1).optional(),
  groupName: z.string().trim().max(120).optional(),
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