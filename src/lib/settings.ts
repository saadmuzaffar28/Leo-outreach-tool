import { prisma } from "@/lib/prisma";

export const SEND_MODES = ["live", "test"] as const;
export type SendMode = (typeof SEND_MODES)[number];

export interface SendSettingsData {
  id: string | null;
  userId: string;
  dailySendLimit: number;
  messagesPerMinute: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  maxRetryAttempts: number;
  baseRetryDelaySeconds: number;
  maxRetryDelaySeconds: number;
  sendMode: SendMode;

  // --- Mailbox warm-up global defaults ---
  // These are DEFAULTS for newly enrolled mailboxes only. Each
  // WarmupMailboxSettings row copies them at enrolment and can then diverge,
  // so changing a global default never silently retunes a live ramp.
  //
  // warmupEnabled defaults to FALSE: warm-up never starts on its own.
  warmupEnabled: boolean;
  warmupStartingDailyVolume: number;
  warmupDailyIncrease: number;
  warmupMaximumDailyVolume: number;
  warmupMinDelaySeconds: number;
  warmupMaxDelaySeconds: number;

  updatedAt: Date | null;
}

export const DEFAULT_SEND_SETTINGS = {
  dailySendLimit: 100,
  messagesPerMinute: 3,
  minDelaySeconds: 20,
  maxDelaySeconds: 60,
  maxRetryAttempts: 5,
  baseRetryDelaySeconds: 60,
  maxRetryDelaySeconds: 3600,
  sendMode: "live",
  // Warm-up OFF by default. Nothing sends until an operator enables a mailbox.
  warmupEnabled: false,
  warmupStartingDailyVolume: 5,
  warmupDailyIncrease: 1,
  warmupMaximumDailyVolume: 15,
  warmupMinDelaySeconds: 60,
  warmupMaxDelaySeconds: 120,
} as const satisfies Omit<SendSettingsData, "id" | "userId" | "updatedAt">;

type EditableKey = keyof Omit<SendSettingsData, "id" | "userId" | "updatedAt">;

/** Bounds for the warm-up global defaults. Conservative, and unit tested. */
export const WARMUP_SETTING_BOUNDS = {
  warmupStartingDailyVolume: { min: 1, max: 200 },
  warmupDailyIncrease: { min: 0, max: 50 },
  warmupMaximumDailyVolume: { min: 1, max: 500 },
  warmupMinDelaySeconds: { min: 1, max: 3600 },
  warmupMaxDelaySeconds: { min: 1, max: 24 * 3600 },
} as const;

/**
 * Conservative range validation for the administrator-editable limits.
 * Pure and unit-tested; the API and form both enforce these bounds.
 */
export function isSendSettingsValueValid(key: EditableKey, value: number | SendMode | boolean): boolean {
  switch (key) {
    case "warmupEnabled":
      return typeof value === "boolean";
    case "warmupStartingDailyVolume":
    case "warmupDailyIncrease":
    case "warmupMaximumDailyVolume":
    case "warmupMinDelaySeconds":
    case "warmupMaxDelaySeconds": {
      const b = WARMUP_SETTING_BOUNDS[key as keyof typeof WARMUP_SETTING_BOUNDS];
      return Number.isInteger(value) && (value as number) >= b.min && (value as number) <= b.max;
    }
    case "dailySendLimit":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10_000;
    case "messagesPerMinute":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 60;
    case "minDelaySeconds":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 3600;
    case "maxDelaySeconds":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 24 * 3600;
    case "maxRetryAttempts":
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 50;
    case "baseRetryDelaySeconds":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 24 * 3600;
    case "maxRetryDelaySeconds":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 7 * 24 * 3600;
    case "sendMode":
      return SEND_MODES.includes(value as SendMode);
    default:
      return false;
  }
}

/** Returns the effective settings for a user, using DB row or conservative defaults. */
export async function getSendSettings(userId: string): Promise<SendSettingsData> {
  const row = await prisma.sendSettings.findUnique({ where: { userId } });
  if (!row) {
    return {
      id: null,
      userId,
      ...DEFAULT_SEND_SETTINGS,
      sendMode: DEFAULT_SEND_SETTINGS.sendMode,
      updatedAt: null,
    };
  }
  return mapSendSettings(row);
}

function mapSendSettings(row: {
  id: string;
  userId: string;
  dailySendLimit: number;
  messagesPerMinute: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  maxRetryAttempts: number;
  baseRetryDelaySeconds: number;
  maxRetryDelaySeconds: number;
  sendMode: string;
  warmupEnabled: boolean;
  warmupStartingDailyVolume: number;
  warmupDailyIncrease: number;
  warmupMaximumDailyVolume: number;
  warmupMinDelaySeconds: number;
  warmupMaxDelaySeconds: number;
  updatedAt: Date;
}): SendSettingsData {
  return {
    id: row.id,
    userId: row.userId,
    dailySendLimit: row.dailySendLimit,
    messagesPerMinute: row.messagesPerMinute,
    minDelaySeconds: row.minDelaySeconds,
    maxDelaySeconds: row.maxDelaySeconds,
    maxRetryAttempts: row.maxRetryAttempts,
    baseRetryDelaySeconds: row.baseRetryDelaySeconds,
    maxRetryDelaySeconds: row.maxRetryDelaySeconds,
    sendMode: SEND_MODES.includes(row.sendMode as SendMode) ? (row.sendMode as SendMode) : "live",
    warmupEnabled: row.warmupEnabled,
    warmupStartingDailyVolume: row.warmupStartingDailyVolume,
    warmupDailyIncrease: row.warmupDailyIncrease,
    warmupMaximumDailyVolume: row.warmupMaximumDailyVolume,
    warmupMinDelaySeconds: row.warmupMinDelaySeconds,
    warmupMaxDelaySeconds: row.warmupMaxDelaySeconds,
    updatedAt: row.updatedAt,
  };
}

export type SendSettingsUpdate = Partial<Omit<SendSettingsData, "id" | "userId" | "updatedAt">>;

export async function updateSendSettings(userId: string, patch: SendSettingsUpdate): Promise<SendSettingsData> {
  const row = await prisma.sendSettings.upsert({
    where: { userId },
    update: patch,
    create: { userId, ...DEFAULT_SEND_SETTINGS, ...patch },
  });
  return mapSendSettings(row);
}