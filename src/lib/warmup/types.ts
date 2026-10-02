/**
 * Client-safe warm-up types.
 *
 * Kept separate from `service.ts` because that module imports Prisma, and a
 * "use client" component must never pull the database client into the browser
 * bundle. The dashboard imports from here only.
 *
 * Note what is NOT in these types: any credential, encrypted blob, username or
 * password. The API layer is responsible for never emitting them, and the types
 * make that contract explicit.
 */

export type WarmupMailboxStatus = "running" | "paused" | "paused_error";

export interface WarmupMailboxView {
  smtpAccountId: string;
  settingsId: string | null;
  email: string;
  domain: string;
  connectionType: "smtp";
  host: string;
  port: number;
  security: string;
  connectionStatus: string;
  imapConfigured: boolean;
  imapStatus: string;
  /** `Date` on the server; the ISO string once JSON-serialised for the browser. */
  imapLastTestedAt: Date | string | null;
  imapLastTestError: string | null;

  enrolled: boolean;
  enabled: boolean;
  status: WarmupMailboxStatus;
  statusMessage: string | null;
  currentDay: number;
  startingDailyVolume: number;
  maximumDailyVolume: number;
  dailyIncrease: number;
  minimumDelaySeconds: number;
  maximumDelaySeconds: number;
  warmupWindowStart: string;
  warmupWindowEnd: string;
  pauseOnError: boolean;
  maxConsecutiveFailures: number;

  dailyTarget: number;
  todaySent: number;
  todayDelivered: number;
  sharedBudgetLeft: number;
  warmupAllowance: number;
  todayFailed: number;

  lastSendAt: Date | string | null;
  lastActiveDate: string | null;
  consecutiveSuccessfulDays: number;
  consecutiveFailures: number;
  startedAt: Date | string | null;
}

export interface WarmupStatsView {
  totalSends: number;
  totalDelivered: number;
  totalFailed: number;
  totalUnconfirmed: number;
  smtpFailures: number;
  imapFailures: number;
  averageLatencyMs: number | null;
  consecutiveSuccessfulDays: number;
  consecutiveFailures: number;
  currentDay: number;
  dailyTarget: number;
  todaySent: number;
  todayDelivered: number;
  daily: Array<{
    date: string;
    warmupSent: number;
    delivered: number;
    warmupFailed: number;
    target: number;
  }>;
}

export interface WarmupEventView {
  id: string;
  type: string;
  message: string | null;
  createdAt: Date | string;
  mailboxId: string;
  jobId: string | null;
  meta: Record<string, unknown> | null;
}

export interface WarmupGlobalSettings {
  warmupEnabled: boolean;
  warmupStartingDailyVolume: number;
  warmupDailyIncrease: number;
  warmupMaximumDailyVolume: number;
  warmupMinDelaySeconds: number;
  warmupMaxDelaySeconds: number;
}

/** Human label + tone for each warm-up status. */
export function describeStatus(m: WarmupMailboxView): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (m.status === "paused_error") {
    return { label: "Paused (error)", tone: "bad" };
  }
  if (m.status === "running" && m.enabled) {
    return { label: "Running", tone: "ok" };
  }
  if (m.enabled) return { label: "Enabled", tone: "warn" };
  return { label: "Disabled", tone: "muted" };
}