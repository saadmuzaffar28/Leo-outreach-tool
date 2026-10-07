import { z } from "zod";

const boolFromString = (v: string | undefined, def: boolean) =>
  v === undefined ? def : v === "1" || v.toLowerCase() === "true";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3002"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  TOKEN_ENCRYPTION_KEY: z.string().min(32, "TOKEN_ENCRYPTION_KEY must be at least 32 characters"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().default(""),
  // Microsoft Outlook (Entra ID) OAuth 2.0 — optional; the Settings page shows
  // "Connect Outlook" once MICROSOFT_CLIENT_ID and SECRET are configured.
  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_TENANT_ID: z.string().default("common"),
  MICROSOFT_REDIRECT_URI: z.string().default(""),
  ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  ADMIN_NAME: z.string().default("Admin"),
  ADMIN_PASSWORD: z.string().min(1).default("changeme"),
  SENDER_NAME: z.string().default("Leo's outreach"),
  SEND_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(45),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(20),
  MAX_RETRIES: z.coerce.number().int().min(0).default(5),
  RETRY_BASE_DELAY_SECONDS: z.coerce.number().int().min(1).default(60),
  LOG_LEVEL: z.string().default("info"),
  // 8x8 Connect SMS — optional; when absent the app runs in mock/demo mode.
  X8_API_KEY: z.string().default(""),
  X8_SUBACCOUNT_ID: z.string().default(""),
  // Shared secret sent by 8x8 in the Authorization header of webhook calls.
  X8_WEBHOOK_AUTH: z.string().default(""),
  /**
   * Extra origins that are allowed to make state-changing requests, as a
   * comma-separated list, e.g. "http://localhost:3010,http://192.168.1.5:3010".
   *
   * This exists for local/LAN use while the public APP_URL host (a Cloudflare
   * Quick Tunnel) is unreachable. It must NOT be used to widen trust generally:
   * every entry is an origin a browser is trusted to send state-changing
   * requests from, so keep it to loopback/private addresses you control.
   * APP_URL itself is always accepted and does not need to be listed here.
   */
  ALLOWED_ORIGINS: z.string().default(""),
  // -------------------------------------------------------------------------
  // Email verification (self-hosted AfterShip/email-verifier sidecar).
  // All values have safe defaults — see .env.example for documentation.
  // -------------------------------------------------------------------------
  EMAIL_VERIFICATION_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  /** Loopback URL of the local Go verification service. */
  EMAIL_VERIFICATION_SERVICE_URL: z.string().default("http://127.0.0.1:8099"),
  /** Shared bearer token between the app and the verification service. */
  EMAIL_VERIFICATION_SERVICE_TOKEN: z.string().default(""),
  /** Days a stored result stays fresh enough to reuse from cache. */
  EMAIL_VERIFICATION_CACHE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** Max verifications in flight (worker-side). Conservative by default. */
  EMAIL_VERIFICATION_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  /** Whole-request timeout toward the verification service (ms). */
  EMAIL_VERIFICATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Pause between starting individual verifications (ms) — go easy on MX/SMTP servers. */
  EMAIL_VERIFICATION_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  /** Max retries for retryable failures (timeouts, 4xx, engine down). */
  EMAIL_VERIFICATION_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
});

function loadEnv() {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return envSchema.parse({
      DATABASE_URL: "postgresql://build:build@localhost:5432/build",
      SESSION_SECRET: "build-time-placeholder-secret-32-chars-min",
      TOKEN_ENCRYPTION_KEY: "build-time-placeholder-key-32-chars-min!!",
    });
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export type AppEnv = z.infer<typeof envSchema>;

export const env: AppEnv = loadEnv();

export const SEND_INTERVAL_MS = env.SEND_INTERVAL_SECONDS * 1000;
export const POLL_INTERVAL_MS = env.POLL_INTERVAL_SECONDS * 1000;
export const IS_PRODUCTION = boolFromString(process.env.NODE_ENV, false);