import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      APP_URL: "http://localhost:3000",
      SESSION_SECRET: "test-session-secret-that-is-long-enough-1234567890",
      TOKEN_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough-1234567890",
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "password",
      SEND_INTERVAL_SECONDS: "45",
      POLL_INTERVAL_SECONDS: "20",
      MAX_RETRIES: "5",
      RETRY_BASE_DELAY_SECONDS: "60",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});