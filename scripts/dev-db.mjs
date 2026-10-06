/**
 * PM2 entry point for `leo-db`.
 *
 * This file used to construct an `EmbeddedPostgres` instance, run `initdb`
 * against `.pgdata` on every single boot, await `pg.start()` with no error
 * handling, and then hold the event loop open with `setInterval(() => {})`.
 * The consequences, all of which were observed on this host:
 *
 *   - `initdb: error: directory ".pgdata" exists but is not empty` on every boot.
 *   - When startup failed, the library rejected with no argument, so Node
 *     reported an uncaught exception whose value was literally `undefined`.
 *   - Nothing ever checked whether PostgreSQL was still alive, so PM2 reported
 *     `leo-db online` for over an hour over a database that had already died.
 *
 * All of that now lives in `scripts/lib/pg-supervisor.mjs`. This file is
 * deliberately nothing but argument handling and a call into it, because the
 * database is the one process whose availability must not depend on any other
 * part of this toolchain working -- so it runs on plain `node`, with no build
 * step and no loader.
 *
 * Usage:
 *   node scripts/dev-db.mjs            supervise the cluster under .pgdata
 *   node scripts/dev-db.mjs --status   report cluster facts, change nothing
 *   node scripts/dev-db.mjs --help     usage
 */

import {
  buildSupervisorConfig,
  collectStatusReport,
  createSupervisor,
} from "./lib/pg-supervisor.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

if (flag("--help") || flag("-h")) {
  console.log(
    [
      "Usage: node scripts/dev-db.mjs [--status]",
      "",
      "  (no arguments)  Start or adopt the PostgreSQL cluster for the configured",
      "                  data directory, then monitor it. Exits non-zero if the",
      "                  database cannot be brought up or later dies, so that PM2",
      "                  sees a real failure.",
      "",
      "  --status        Read-only report: cluster presence, pg_ctl status, port",
      "                  state, recorded postmaster PID, ownership marker, and any",
      "                  orphaned postgres.exe processes. Changes nothing.",
      "",
      "Environment overrides (all optional):",
      "  LEO_DB_PORT                  default 5438",
      "  LEO_DB_DATA_DIR              default .pgdata",
      "  LEO_DB_OWNER_FILE            default .leo-db-owner.json",
      "  LEO_DB_START_TIMEOUT_MS      default 60000",
      "  LEO_DB_STOP_TIMEOUT_MS       default 30000",
      "  LEO_DB_HEALTH_INTERVAL_MS    default 10000 (0 disables the monitor)",
      "  LEO_DB_TCP_FAILURES          default 3",
      "  LEO_DB_MAX_START_ATTEMPTS    default 2",
      "  LEO_DB_REAP_STALE            default 1 (allow targeted orphan cleanup)",
      "  LEO_DB_ALLOW_INITDB          default 0 (initdb is never run)",
      "  LEO_DB_PG_BIN                directory containing postgres/pg_ctl",
    ].join("\n"),
  );
  process.exit(0);
}

const config = buildSupervisorConfig(process.env, process.cwd());

if (flag("--status")) {
  try {
    const report = await collectStatusReport(config);
    console.log("[dev-db] read-only status report");
    console.log(`  dataDir                ${report.dataDir}`);
    console.log(`  clusterPresent         ${report.clusterExists}`);
    console.log(`  port                   ${report.port}`);
    console.log(`  pgCtlStatus            ${report.pgCtlStatus} (0=running, 3=no server)`);
    console.log(`  portListening          ${report.portListening}`);
    console.log(`  portOwnerPid           ${report.portOwnerPid ?? "(unknown)"}`);
    console.log(
      `  postmaster.pid         ${report.postmasterPidFile ? `${report.postmasterPidFile.pid} (alive=${isAlive(report.postmasterPidFile.pid)})` : "(absent)"}`,
    );
    console.log(
      `  ownershipMarker        ${report.ownerMarker ? `pid=${report.ownerMarker.pid} dataDir=${report.ownerMarker.dataDir}` : "(none)"}`,
    );
    console.log(`  postgres.exe running   ${report.postgresProcessCount}`);
    console.log(`  orphaned postgres.exe  ${report.orphanedPostgresProcesses.length}`);
    for (const proc of report.orphanedPostgresProcesses) {
      console.log(`      pid=${proc.pid} ppid=${proc.parentPid} (parent not alive)`);
    }
    console.log(`  startup decision       ${report.decision}`);
    process.exit(0);
  } catch (err) {
    console.error("[dev-db] status report failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

const supervisor = createSupervisor({ config });
const exitCode = await supervisor.run();

// `run()` resolves to a non-zero code when startup failed, and to 0 when the
// supervisor is now monitoring a healthy database. In the success case the
// process is intentionally kept alive by the health monitor and the installed
// signal handlers; it exits through `onFatal` when the database dies or when a
// termination signal arrives.
if (exitCode !== 0) {
  process.exit(exitCode);
}