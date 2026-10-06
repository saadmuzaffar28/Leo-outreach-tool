/**
 * PM2 ecosystem for Leo Outreach Tool (Star Billing Outreach)
 *
 * Four processes:
 *   leo-db                 PostgreSQL 18 on 127.0.0.1:5438, supervised by
 *                          scripts/dev-db.mjs (see scripts/lib/pg-supervisor.mjs)
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
      // `leo-db` supervises the cluster that every other process depends on, so
      // its restart policy is deliberately different from the other three.
      //
      // The previous policy was autorestart + max_restarts:50 + restart_delay
      // 5000. Because the old wrapper failed on every attempt (it ran initdb
      // against a live data directory, then hit `pre-existing shared memory
      // block is still in use`), that combination produced 51 restart attempts
      // in roughly 12 minutes before PM2 gave up and left the app definitions
      // pointing at a dead database. It also left `leo-db` reporting `online`
      // while PostgreSQL was gone, because nothing verified the postmaster.
      //
      // Changes, and why:
      //   kill_timeout 8000     PM2 previously killed the wrapper almost at once,
      //                         so the SIGTERM handler that stops PostgreSQL
      //                         cleanly never got to run.
      //   min_uptime 30000     A process that dies within 30s of starting is
      //                         counted as an unstable start, so a genuine
      //                         "PostgreSQL will not boot" condition cannot burn
      //                         the whole restart budget in seconds.
      //   max_restarts 10      Halves the worst case, and each attempt is now
      //                         idempotent (no duplicate clusters), so ten is
      //                         plenty.
      //   restart_delay 10000  Gives PostgreSQL time to flush and shut down.
      //   exp_backoff_restart_delay 15000
      //                         PM2 grows the delay geometrically between
      //                         restarts, so repeated failures stop hammering
      //                         the port and the data directory.
      //   env additions        Explicit, documented supervisor knobs. The
      //                         defaults in scripts/lib/pg-supervisor.mjs are
      //                         the same values, so a bare `node
      //                         scripts/dev-db.mjs` behaves identically.
      name: "leo-db",
      script: path.join(cwd, "scripts", "dev-db.mjs"),
      interpreter: NODE_BIN,
      cwd,
      env: {
        NODE_ENV: "production",
        LEO_DB_PORT: "5438",
        LEO_DB_START_TIMEOUT_MS: "60000",
        LEO_DB_HEALTH_INTERVAL_MS: "10000",
        LEO_DB_STOP_TIMEOUT_MS: "30000",
        // Startup is a no-op for an existing cluster. Kept explicit so it cannot
        // be mistaken for permission to reinitialise anything.
        LEO_DB_ALLOW_INITDB: "0",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      min_uptime: 30000,
      exp_backoff_restart_delay: 15000,
      kill_timeout: 8000,
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
  ],
};
