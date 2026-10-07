/**
 * PM2 ecosystem for Leo Outreach Tool (Star Billing Outreach)
 *
 * Five processes:
 *   leo-outreach            Next.js production web server on 0.0.0.0:3010
 *   leo-outreach-worker     campaign send-queue worker (one instance only - see README)
 *   leo-outreach-warmup     mailbox warm-up worker (separate from campaigns on purpose)
 *   leo-outreach-verify     email verification queue worker (AfterShip engine jobs)
 *   leo-verifier            self-hosted Go verification service (build it first:
 *                           `npm run verifier:build`; binary at dist/verifier/)
 *
 * PostgreSQL is deliberately NOT listed here. It runs as the Windows service
 * `LeoPostgres` (Session 0, port 5438, data dir
 * C:\deploy\Leo-outreach-tool.old\.pgdata), owned by the Service Control
 * Manager. No PM2 process may start, stop or supervise it - the `leo-db` entry
 * and scripts/dev-db.mjs were removed for that reason, because PM2 -> node.exe
 * -> postgres.exe put PostgreSQL in the interactive console session and produced
 * conhost popup windows.
 *
 * NOTE: `npm start` alone would use Next's default port 3000, which is already
 * taken on this host by the existing "COLLAB CRM" app. We therefore invoke the
 * Next binary directly with an explicit -p 3010 -H 0.0.0.0.
 */
const path = require("path");

const NODE_BIN = process.execPath; // absolute node.exe - survives PATH changes
const cwd = __dirname;

module.exports = {
  apps: [
    {
      name: "leo-outreach",
      script: path.join(
        cwd,
        "node_modules",
        "next",
        "dist",
        "bin",
        "next",
      ),
      args: "start -p 3010 -H 0.0.0.0",
      interpreter: NODE_BIN,
      cwd,
      env: { NODE_ENV: "production", PORT: "3010" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-outreach-out.log"),
      error_file: path.join(cwd, "logs", "leo-outreach-error.log"),
    },
    {
      name: "leo-outreach-worker",
      script: path.join(cwd, "dist", "workers", "scripts", "worker.js"),
      interpreter: NODE_BIN,
      cwd,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5438/star_billing_outreach?connection_limit=1&sslmode=disable",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-worker-out.log"),
      error_file: path.join(cwd, "logs", "leo-worker-error.log"),
    },
    {
      name: "leo-outreach-warmup",
      script: path.join(cwd, "dist", "workers", "scripts", "warmup-worker.js"),
      interpreter: NODE_BIN,
      cwd,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5438/star_billing_outreach?connection_limit=1&sslmode=disable",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-warmup-out.log"),
      error_file: path.join(cwd, "logs", "leo-warmup-error.log"),
    },
    {
      // Email verification queue worker (DB-backed jobs → AfterShip engine).
      name: "leo-outreach-verify",
      script: path.join(cwd, "dist", "workers", "scripts", "verification-worker.js"),
      interpreter: NODE_BIN,
      cwd,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5438/star_billing_outreach?connection_limit=1&sslmode=disable",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-verify-worker-out.log"),
      error_file: path.join(cwd, "logs", "leo-verify-worker-error.log"),
    },
    {
      // Self-hosted verification service (Go, wraps AfterShip/email-verifier).
      // Binary must exist first: `npm run verifier:build`.
      name: "leo-verifier",
      script: path.join(
        cwd,
        "dist",
        "verifier",
        process.platform === "win32" ? "email-verifier.exe" : "email-verifier",
      ),
      interpreter: "none",
      cwd,
      env: {
        EMAIL_VERIFICATION_LISTEN: "127.0.0.1:8099",
        EMAIL_VERIFICATION_SMTP_ENABLED: "true",
        EMAIL_VERIFICATION_TIMEOUT_MS: "15000",
        EMAIL_VERIFICATION_MAX_INFLIGHT: "4",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-verifier-out.log"),
      error_file: path.join(cwd, "logs", "leo-verifier-error.log"),
    },
  ],
};
