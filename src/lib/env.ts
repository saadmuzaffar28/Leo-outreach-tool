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