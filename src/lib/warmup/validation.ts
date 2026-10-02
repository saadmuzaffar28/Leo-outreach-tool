import { z } from "zod";
import { parseHhMm } from "@/lib/warmup/ramp";

/**
 * Mailbox warm-up validation.
 *
 * Deliberately CONSERVATIVE bounds. A warm-up volume is real outbound mail from
 * a real mailbox, so these caps exist to stop a typo (a stray zero, a pasted
 * campaign limit) from turning warm-up into an unbounded blast. They are NOT a
 * statement about what volume is safe -- nothing here knows that.
 */

/** "HH:mm", validated for real rather than by regex alone. */
const windowTime = z
  .string()
  .trim()
  .refine((v) => parseHhMm(v) !== null, "Use 24-hour HH:mm, e.g. 09:00");

export const warmupBounds = {
  startingDailyVolume: { min: 1, max: 200 },
  maximumDailyVolume: { min: 1, max: 500 },
  dailyIncrease: { min: 0, max: 50 },
  minimumDelaySeconds: { min: 1, max: 3600 },
  maximumDelaySeconds: { min: 1, max: 24 * 3600 },
  maxConsecutiveFailures: { min: 1, max: 50 },
} as const;

const bounded = (label: string, min: number, max: number) =>
  z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);

export const warmupMailboxSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    startingDailyVolume: bounded("Starting daily volume", warmupBounds.startingDailyVolume.min, warmupBounds.startingDailyVolume.max).optional(),
    maximumDailyVolume: bounded("Maximum daily volume", warmupBounds.maximumDailyVolume.min, warmupBounds.maximumDailyVolume.max).optional(),
    dailyIncrease: bounded("Daily increase", warmupBounds.dailyIncrease.min, warmupBounds.dailyIncrease.max).optional(),
    minimumDelaySeconds: bounded("Minimum delay", warmupBounds.minimumDelaySeconds.min, warmupBounds.minimumDelaySeconds.max).optional(),
    maximumDelaySeconds: bounded("Maximum delay", warmupBounds.maximumDelaySeconds.min, warmupBounds.maximumDelaySeconds.max).optional(),
    warmupWindowStart: windowTime.optional(),
    warmupWindowEnd: windowTime.optional(),
    pauseOnError: z.boolean().optional(),
    maxConsecutiveFailures: bounded("Max consecutive failures", warmupBounds.maxConsecutiveFailures.min, warmupBounds.maxConsecutiveFailures.max).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No settings supplied" })
  // Cross-field rules that a per-field bound cannot express.
  .refine(
    (v) =>
      v.startingDailyVolume === undefined ||
      v.maximumDailyVolume === undefined ||
      v.startingDailyVolume <= v.maximumDailyVolume,
    { message: "Starting daily volume cannot exceed the maximum daily volume" },
  )
  .refine(
    (v) =>
      v.minimumDelaySeconds === undefined ||
      v.maximumDelaySeconds === undefined ||
      v.minimumDelaySeconds <= v.maximumDelaySeconds,
    { message: "Minimum delay cannot exceed the maximum delay" },
  );

export const warmupGlobalSettingsSchema = z
  .object({
    warmupEnabled: z.boolean().optional(),
    warmupStartingDailyVolume: bounded("Default starting daily volume", warmupBounds.startingDailyVolume.min, warmupBounds.startingDailyVolume.max).optional(),
    warmupDailyIncrease: bounded("Default daily increase", warmupBounds.dailyIncrease.min, warmupBounds.dailyIncrease.max).optional(),
    warmupMaximumDailyVolume: bounded("Default maximum warm-up volume", warmupBounds.maximumDailyVolume.min, warmupBounds.maximumDailyVolume.max).optional(),
    warmupMinDelaySeconds: bounded("Default minimum delay", warmupBounds.minimumDelaySeconds.min, warmupBounds.minimumDelaySeconds.max).optional(),
    warmupMaxDelaySeconds: bounded("Default maximum delay", warmupBounds.maximumDelaySeconds.min, warmupBounds.maximumDelaySeconds.max).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No settings supplied" })
  .refine(
    (v) =>
      v.warmupStartingDailyVolume === undefined ||
      v.warmupMaximumDailyVolume === undefined ||
      v.warmupStartingDailyVolume <= v.warmupMaximumDailyVolume,
    { message: "Default starting volume cannot exceed the default maximum volume" },
  )
  .refine(
    (v) =>
      v.warmupMinDelaySeconds === undefined ||
      v.warmupMaxDelaySeconds === undefined ||
      v.warmupMinDelaySeconds <= v.warmupMaxDelaySeconds,
    { message: "Default minimum delay cannot exceed the default maximum delay" },
  );

export const warmupEventsQuerySchema = z.object({
  mailboxId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  type: z.string().trim().max(40).optional(),
});

export const warmupStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  mailboxId: z.string().trim().min(1).optional(),
});

/** Per-mailbox IMAP configuration. The password is write-only: it is encrypted
 *  on the way in and is NEVER returned by any GET endpoint. */
export const imapConfigSchema = z
  .object({
    imapHost: z
      .string()
      .trim()
      .max(255)
      .regex(/^[A-Za-z0-9._-]+$/, "IMAP host may only contain letters, digits, dots, dashes")
      .nullable()
      .optional(),
    imapPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
    imapSecurity: z.enum(["ssl", "starttls", "none"]).nullable().optional(),
    imapUsername: z.string().trim().max(255).nullable().optional(),
    /** Absent/null means "keep the existing stored password". */
    imapPassword: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No IMAP settings supplied" });