/**
 * PM2 ecosystem for Leo Outreach Tool (Star Billing Outreach)
 *
 * Four processes:
 *   leo-db                 embedded PostgreSQL 18 on 127.0.0.1:5438
 *   leo-outreach            Next.js production web server on 0.0.0.0:3010
 *   leo-outreach-worker     campaign send-queue worker (one instance only - see README)
 *   leo-outreach-warmup     mailbox warm-up worker (separate from campaigns on purpose)
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
      name: "leo-db",
      script: path.join(cwd, "scripts", "dev-db.mjs"),
      interpreter: NODE_BIN,
      cwd,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-db-out.log"),
      error_file: path.join(cwd, "logs", "leo-db-error.log"),
    },
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
      script: path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
      args: "scripts/worker.ts",
      interpreter: NODE_BIN,
      cwd,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-worker-out.log"),
      error_file: path.join(cwd, "logs", "leo-worker-error.log"),
    },
    {
      name: "leo-outreach-warmup",
      script: path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
      args: "scripts/warmup-worker.ts",
      interpreter: NODE_BIN,
      cwd,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(cwd, "logs", "leo-warmup-out.log"),
      error_file: path.join(cwd, "logs", "leo-warmup-error.log"),
    },
  ],
};
