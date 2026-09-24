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
} as const satisfies Omit<SendSettingsData, "id" | "userId" | "updatedAt">;

/**
 * Conservative range validation for the administrator-editable limits.
 * Pure and unit-tested; the API and form both enforce these bounds.
 */
export function isSendSettingsValueValid(
  key: keyof Omit<SendSettingsData, "id" | "userId" | "updatedAt">,
  value: number | SendMode,
): boolean {
  switch (key) {
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
  const sendMode = SEND_MODES.includes(row.sendMode as SendMode) ? (row.sendMode as SendMode) : "live";
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
    sendMode,
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
    updatedAt: row.updatedAt,
  };
}