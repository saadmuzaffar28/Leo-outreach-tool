/**
 * PostgreSQL supervisor for the Leo Outreach Tool.
 *
 * WHY THIS FILE EXISTS (and why `embedded-postgres` is not used to start the
 * production cluster)
 * =============================================================================
 *
 * The previous wrapper (`scripts/dev-db.mjs`) delegated lifecycle management to
 * `EmbeddedPostgres`. That library is fine for throwaway test clusters and
 * actively harmful for a long-lived production process, for four specific
 * reasons that map one-to-one onto the failures observed on this host:
 *
 *   1. `EmbeddedPostgres.start()` rejects with NO ARGUMENT when the postmaster
 *      exits before printing its readiness line:
 *
 *          this.process.on('close', () => { reject(); });
 *
 *      A bare `reject()` produces an unhandled rejection whose value is
 *      `undefined`, which Node renders as
 *
 *          node:internal/modules/run_main:107
 *              triggerUncaughtException(
 *              ^
 *          undefined
 *
 *      That is literally the content of `logs/leo-db-error.log`. The wrapper
 *      also had no try/catch, so the operator got a stack trace with no cause.
 *
 *   2. `start()` has no timeout and matches its readiness string with
 *      `chunk.includes('database system is ready to accept connections')`.
 *      stderr arrives in arbitrary chunks; if that line is split across two
 *      chunks the promise never settles and the wrapper sits there "online"
 *      forever with no database behind it.
 *
 *   3. `stop()` on Windows runs `taskkill /pid <pid> /f /t` -- a hard kill of
 *      the whole tree. PostgreSQL never gets to write `postmaster.pid`, flush
 *      WAL, or shut down its shared memory segment, so the next start can hit
 *
 *          FATAL: pre-existing shared memory block is still in use
 *          HINT: Check if there are any old server processes still running, and terminate them.
 *
 *      which is what wedged `leo-db` for 51 restart attempts.
 *
 *   4. Nothing ever watches the postmaster after startup. The old wrapper ended
 *      with `setInterval(() => {}, 1 << 30)`, so if the postmaster died the
 *      wrapper kept running and PM2 kept reporting `leo-db online` over a dead
 *      database.
 *
 * So this module supervises `postgres.exe` directly. It owns one postmaster
 * process, identified by PID, and it is written so that the failure modes above
 * are structurally impossible:
 *
 *   - `spawnPostgres` detaches the child into its own process group, so a
 *     console control event (`STATUS_CONTROL_C_EXIT` / 0xC000013A) aimed at this
 *     wrapper's console cannot reach PostgreSQL.
 *   - Readiness is line-buffered (never a substring of a raw chunk) and then
 *     CONFIRMED with `pg_ctl status` plus a real TCP connect to the port.
 *   - Every failure path carries a real Error with a real message. There is no
 *     bare `reject()`.
 *   - Startup is idempotent: an already-healthy cluster for this data directory
 *     is ADOPTED, never duplicated.
 *   - `initdb` is never run against an existing data directory. Not even
 *     defensively -- running it is what produced
 *     `initdb: error: directory ".pgdata" exists but is not empty` on every
 *     single boot, and it also writes the cluster password in cleartext to a
 *     temp file each time.
 *   - If PostgreSQL dies, the wrapper exits non-zero so PM2 sees a real failure.
 *
 * DELIBERATE SCOPE LIMITS
 * ----------------------
 * - Plain `.mjs` run by plain `node`, with no build step and no loader (no
 *   tsx). The database is the one process whose availability must not depend on
 *   anything else in the toolchain working.
 * - No new npm dependency. The `pg` client (only needed for the optional
 *   "create the application database if it is missing" step) is resolved
 *   through `embedded-postgres`' own dependency tree, and PostgreSQL's own
 *   `pg_ctl.exe` is used for liveness and for clean shutdown.
 * - Nothing in this file deletes, reinitialises, or migrates a data directory.
 *   `terminateOwned()` is the only code path that terminates a process, it
 *   targets a single PID it owns, and it prefers `pg_ctl stop` over a kill.
 *
 * This module is side-effect free on import; `scripts/dev-db.mjs` calls
 * `createSupervisor(...).run()`.
 */

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[dev-db]";

/** PostgreSQL writes its server log to stderr; these are the lines we act on. */
export const PG_READY_LINE = "database system is ready to accept connections";
export const PG_SHM_BUSY_LINE = "pre-existing shared memory block is still in use";
export const PG_SHUTDOWN_LINE = "database system is shut down";

/** `pg_ctl status` exit codes, per PostgreSQL's documented interface. */
export const PG_CTL_RUNNING = 0;
export const PG_CTL_NO_SERVER = 3;

/** Reasons the supervisor can refuse to act. Surfaced verbatim in the log. */
export const STARTUP_SHM_BUSY = "shared-memory-in-use";
export const STARTUP_FATAL = "fatal";
export const STARTUP_EXITED = "postmaster-exited";
export const STARTUP_TIMEOUT = "readiness-timeout";
export const STARTUP_SPAWN_ERROR = "spawn-error";

/**
 * Sentinel returned by stale cleanup when it was switched off, so the caller can
 * tell "declined to look" apart from "looked and found nothing".
 */
const STALE_CLEANUP_DISABLED = -1;

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/**
 * Parse a `postmaster.pid` file. This is PostgreSQL's own authoritative record
 * of which process owns a data directory, and `pg_ctl status` is built on it.
 *
 * Layout (one field per line):
 *   1. postmaster PID
 *   2. absolute path of the data directory
 *   3. start time, seconds since the Unix epoch
 *   4. port
 *   5. socket directory (blank on Windows)
 */
export function parsePostmasterPidFile(text) {
  if (typeof text !== "string") return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 4) return null;

  const pid = Number.parseInt(lines[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const startEpoch = Number.parseInt(lines[2], 10);
  const port = Number.parseInt(lines[3], 10);

  return {
    pid,
    dataDir: lines[1],
    startEpoch: Number.isInteger(startEpoch) ? startEpoch : null,
    port: Number.isInteger(port) ? port : null,
  };
}

/**
 * A line-buffered accumulator.
 *
 * The old wrapper matched its readiness string with
 * `stderrChunk.includes(...)`, which silently fails whenever the line is split
 * across two TCP reads. Buffering to newlines makes the match chunk-boundary
 * independent. `flush()` releases a trailing partial line, which is how the
 * final chunk of a process that dies mid-write gets inspected.
 */
export function createLineBuffer() {
  let carry = "";
  return {
    push(chunk) {
      carry += String(chunk);
      const complete = [];
      let index = carry.indexOf("\n");
      while (index >= 0) {
        complete.push(carry.slice(0, index).replace(/\r$/, ""));
        carry = carry.slice(index + 1);
        index = carry.indexOf("\n");
      }
      return complete;
    },
    flush() {
      const rest = carry.trim();
      carry = "";
      return rest.length > 0 ? [rest] : [];
    },
  };
}

/**
 * Classify a single line of PostgreSQL server output.
 *
 * Returns `PG_READY_LINE`-equivalent `ready`, a specific non-null failure
 * reason, or `null` for an uninteresting line. Classification is deliberately
 * conservative: an unrecognised line is never treated as a failure, because a
 * false failure would tear down a healthy database.
 */
export function classifyPostgresLine(line) {
  const text = String(line ?? "");
  if (text.includes(PG_READY_LINE)) return "ready";
  if (text.includes(PG_SHM_BUSY_LINE)) return STARTUP_SHM_BUSY;
  if (
    text.includes("another postmaster is already running") ||
    text.includes("could not bind") ||
    text.includes("could not create any TCP/IP sockets")
  ) {
    return "port-in-use";
  }
  if (text.includes("is not a data directory")) return "bad-data-directory";
  // A FATAL that is not one of the above still means this postmaster is not
  // coming up, and it is far better to stop and report it than to keep waiting
  // for a readiness line that will never arrive.
  if (/\bFATAL\b/.test(text)) return STARTUP_FATAL;
  return null;
}

/**
 * Decide what the supervisor should do, given two independent probes.
 *
 * `pg_ctlStatus` is the answer to "does a postmaster own this data directory?"
 * (0 = yes, 3 = no). `portListening` is the answer to "is anything accepting
 * TCP connections on our port?". Asking both is what makes startup idempotent:
 * either probe alone has a blind spot.
 *
 *   - server running + port answering          -> adopt (do not spawn)
 *   - server running + port refusing           -> refuse; it is still starting
 *                                                 up or wedged. Spawning a second
 *                                                 postmaster here is how you get
 *                                                 duplicate clusters.
 *   - no server + port answering               -> refuse; something unrelated
 *                                                 owns the port. Never fight
 *                                                 over it.
 *   - no server + port free                    -> start
 *   - `pg_ctl` itself unusable                 -> refuse; we cannot verify, and
 *                                                 "cannot verify" must not mean
 *                                                 "spawn anyway".
 */
export function decideStartupAction(input) {
  const { pgCtlStatus, portListening } = input;

  if (pgCtlStatus === null) return "refuse-pgctl-unavailable";
  if (pgCtlStatus === PG_CTL_RUNNING) {
    return portListening ? "adopt" : "refuse-existing-unhealthy";
  }
  if (portListening) return "refuse-port-conflict";
  return "start";
}

/**
 * Decide whether a given `postgres.exe` process may be terminated as stale
 * shared-memory cleanup.
 *
 * This guard is the difference between "targeted" and "blind" process killing.
 * A process qualifies only if ALL of the following hold:
 *
 *   - it is a `postgres.exe`;
 *   - it is not a PID this supervisor owns or is currently starting;
 *   - it is not the PID holding the listening socket;
 *   - its recorded parent PID is known, and that parent is NOT alive.
 *
 * The last condition is what makes this safe. On Windows a forked io_worker
 * records the postmaster that spawned it. If that postmaster is alive -- even
 * for a completely unrelated throwaway test cluster -- the io_worker belongs to
 * a running cluster and is not ours to touch. Only when the parent is provably
 * dead is the child a leaked handle holding a shared memory segment open.
 *
 * `isPidAlive` and `liveness` are injected so this stays pure and testable.
 */
export function isEligibleStaleProcess(proc, ctx) {
  if (!proc || typeof proc.pid !== "number" || proc.pid <= 0) return false;
  if (proc.imageName && !/^postgres(\.exe)?$/i.test(proc.imageName)) return false;
  if (ctx.protectedPids.includes(proc.pid)) return false;
  if (typeof proc.parentPid !== "number" || proc.parentPid <= 0) return false;
  if (ctx.isPidAlive(proc.parentPid)) return false;
  if (typeof ctx.liveness?.get === "function") {
    if (ctx.liveness.get(proc.parentPid)) return false;
  }
  return true;
}

/**
 * Strip credential-shaped substrings from anything bound for a log file.
 *
 * Two passes: connection-URL userinfo (`scheme://user:secret@host`), then
 * `key=value` / `key: value` pairs for the usual secret key names. Applied to
 * every line this module logs, including raw PostgreSQL output, because the
 * failure being debugged is by definition unknown text.
 */
export function redactForLog(text) {
  let out = String(text ?? "");
  out = out.replace(/(:\/\/[^:@\s/]*:)[^@\s/]*@/g, "$1<redacted>@");
  out = out.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_match, key, sep) => `${key}${sep}<redacted>`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readIntEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function readBoolEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

/**
 * Build the supervisor configuration from the environment.
 *
 * Every value has a default that reproduces today's production setup, so the
 * PM2 app definition needs no new environment for a normal boot.
 */
export function buildSupervisorConfig(env = process.env, cwd = process.cwd()) {
  const port = readIntEnv(env, "LEO_DB_PORT", 5438);
  const dataDir = path.resolve(cwd, env.LEO_DB_DATA_DIR || ".pgdata");

  return {
    port,
    host: env.LEO_DB_HOST || "127.0.0.1",
    dataDir,
    /** Marks a real cluster: both files exist or the directory is unusable. */
    pgVersionFile: path.join(dataDir, "PG_VERSION"),
    pgControlFile: path.join(dataDir, "global", "pg_control"),
    postmasterPidFile: path.join(dataDir, "postmaster.pid"),

    /**
     * Ownership marker. Lives outside `.pgdata` so it can never be mistaken for
     * cluster content, and survives a PM2 restart so a new wrapper can take over
     * shutdown of a postmaster a previous wrapper started.
     */
    ownerFile: path.resolve(
      cwd,
      env.LEO_DB_OWNER_FILE || ".leo-db-owner.json",
    ),

    startupTimeoutMs: readIntEnv(env, "LEO_DB_START_TIMEOUT_MS", 60_000),
    stopTimeoutMs: readIntEnv(env, "LEO_DB_STOP_TIMEOUT_MS", 30_000),
    /**
     * How long to wait for a postmaster that failed to become ready to actually
     * exit, before the failure is reported. Bounded so a wedged child can never
     * hold up the PM2 restart cycle.
     */
    failedStartExitGraceMs: readIntEnv(env, "LEO_DB_FAILED_EXIT_GRACE_MS", 15_000),
    healthIntervalMs: readIntEnv(env, "LEO_DB_HEALTH_INTERVAL_MS", 10_000),
    /** Consecutive refused connects tolerated before declaring the DB dead. */
    tcpFailuresBeforeFatal: readIntEnv(env, "LEO_DB_TCP_FAILURES", 3),
    /** Attempts to start after clearing stale shared memory. */
    maxStartAttempts: readIntEnv(env, "LEO_DB_MAX_START_ATTEMPTS", 2),
    reapStaleProcesses: readBoolEnv(env, "LEO_DB_REAP_STALE", true),
    /** initdb is opt-in and refused outright when a cluster already exists. */
    allowInitdb: readBoolEnv(env, "LEO_DB_ALLOW_INITDB", false),

    postgresFlags: (env.LEO_DB_POSTGRES_FLAGS || "")
      .split(/\s+/)
      .filter((flag) => flag.length > 0),

    logPrefix: LOG_PREFIX,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Adapters (the only code that touches the operating system)
// ---------------------------------------------------------------------------

/** Resolve `postgres.exe` / `pg_ctl.exe` / `initdb.exe`. */
async function resolveBinaries(env) {
  if (env.LEO_DB_PG_BIN) {
    const binDir = path.resolve(env.LEO_DB_PG_BIN);
    const suffix = os.platform() === "win32" ? ".exe" : "";
    return {
      postgres: path.join(binDir, `postgres${suffix}`),
      pgCtl: path.join(binDir, `pg_ctl${suffix}`),
      initdb: path.join(binDir, `initdb${suffix}`),
    };
  }

  const platformKey =
    os.platform() === "win32"
      ? "windows-x64"
      : os.platform() === "darwin"
        ? os.arch() === "arm64"
          ? "darwin-arm64"
          : "darwin-x64"
        : os.arch() === "arm64"
          ? "linux-arm64"
          : "linux-x64";

  let mod;
  try {
    mod = await import(`@embedded-postgres/${platformKey}`);
  } catch (err) {
    throw new Error(
      `Could not load PostgreSQL binaries for ${platformKey}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Set LEO_DB_PG_BIN to the directory containing postgres/pg_ctl.`,
    );
  }

  return { postgres: mod.postgres, pgCtl: mod.pg_ctl, initdb: mod.initdb };
}

function isPidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. On Windows this maps to an existence query.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user: alive.
    return err?.code === "EPERM";
  }
}

/**
 * Run `pg_ctl` synchronously.
 *
 * Synchronous on purpose: it is used inside signal and exit handlers, where
 * there is no opportunity to await. PostgreSQL's own tooling is the authority
 * here, so this is also the readiness/liveness oracle we trust.
 */
function runPgCtlSync(pgCtl, args, timeoutMs = 20_000) {
  const result = spawnSync(pgCtl, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

/** True when something accepts a TCP connection on the configured port. */
function probeTcpPort(host, port, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** PID currently listening on the configured port, or `null`. */
function findPortOwnerPid(port) {
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  const value = Number.parseInt(String(ps.stdout ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Enumerate running `postgres.exe` processes as `{pid, parentPid, imageName}`.
 *
 * Uses CIM rather than the image name alone so the parent PID -- the field the
 * staleness guard depends on -- is available.
 */
function listPostgresProcesses() {
  if (os.platform() !== "win32") return [];
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue';" +
        `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |` +
        " ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }",
    ],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );

  const rows = [];
  for (const line of String(ps.stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pid, parentPid, imageName] = trimmed.split("|");
    rows.push({
      pid: Number.parseInt(pid, 10),
      parentPid: Number.parseInt(parentPid, 10),
      imageName: imageName ?? "postgres.exe",
    });
  }
  return rows.filter((row) => Number.isInteger(row.pid));
}

/**
 * Terminate exactly one PID.
 *
 * `taskkill` is invoked with an explicit `/PID` and no `/IM` and no `/T`, so it
 * can never reach a process this supervisor did not identify, and can never walk
 * a process tree it has not analysed. On non-Windows platforms a plain
 * `SIGKILL` to the single PID is used instead.
 */
function killSinglePid(pid) {
  if (os.platform() === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/F"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/**
 * Read and validate the ownership marker.
 *
 * Pure apart from the injected filesystem access, so the takeover path -- the
 * one that makes a PM2 restart safe -- is directly testable.
 */
function parseOwnerMarker(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function serializeOwnerMarker(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Read the marker. A missing or malformed marker simply means "not ours". */
export function readOwnerMarker(file, io) {
  try {
    if (!io.fileExists(file)) return null;
    return parseOwnerMarker(io.readFile(file));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Readiness gate
// ---------------------------------------------------------------------------

/**
 * Wait for a spawned postmaster to become ready.
 *
 * Resolves only when the readiness line is seen. Rejects with a real Error --
 * carrying the classification and the offending server line -- on a classified
 * startup failure, on early exit, or on timeout. Never rejects with `undefined`.
 */
function waitForReady(child, options) {
  const { timeoutMs, onServerLine } = options;

  return new Promise((resolve, reject) => {
    const stderrBuffer = createLineBuffer();
    const stdoutBuffer = createLineBuffer();
    let sawReadyLine = false;
    let settled = false;
    let failure = null;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ readyLine: readinessLine });
    };

    let readinessLine = null;
    // Always armed unless explicitly disabled. A readiness gate with no timeout
    // is exactly the defect that let the old wrapper sit "online" with no
    // database behind it, so there is no unbounded default anywhere here.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            settle(
              new Error(
                `${STARTUP_TIMEOUT}: postmaster did not report readiness within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs)
        : null;

    const inspect = (line) => {
      onServerLine?.(line);
      if (sawReadyLine) return;
      const kind = classifyPostgresLine(line);
      if (kind === "ready") {
        sawReadyLine = true;
        readinessLine = line;
        settle(null);
        return;
      }
      if (kind && !failure) {
        failure = new Error(`${kind}: ${line.trim()}`);
      }
    };

    const drain = (stream, buffer) => {
      stream?.on("data", (chunk) => {
        for (const line of buffer.push(chunk.toString("utf8"))) inspect(line);
      });
    };

    drain(child.stderr, stderrBuffer);
    drain(child.stdout, stdoutBuffer);

    child.on("error", (err) => {
      settle(
        new Error(
          `${STARTUP_SPAWN_ERROR}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });

    // `close` rather than `exit`, so stdio is guaranteed flushed and any
    // final partial line is still visible via flush().
    child.on("close", (code, signal) => {
      for (const line of stderrBuffer.flush()) inspect(line);
      for (const line of stdoutBuffer.flush()) inspect(line);
      if (sawReadyLine) {
        settle(null);
        return;
      }
      settle(
        failure ??
          new Error(
            `${STARTUP_EXITED}: postmaster exited before readiness (code=${code}, signal=${signal})`,
          ),
      );
    });
  });
}

/** Resolve when `child` exits, or after `timeoutMs`. */
function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("close", () => done(true));
  });
}

/**
 * Resolve once the PID is no longer alive, or after `timeoutMs`.
 *
 * Needed for the adopted case: when the postmaster was started by a previous
 * wrapper there is no child handle to await, so `pg_ctl stop`'s effect has to be
 * confirmed by polling the PID itself. Without this the supervisor would report
 * a completed shutdown while the server was still up.
 */
function waitForPidGone(pid, timeoutMs, isPidAlive, pollMs = 200) {
  if (!isPidAlive(pid)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (gone) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(poller);
      resolve(gone);
    };
    const poller = setInterval(() => {
      if (!isPidAlive(pid)) finish(true);
    }, pollMs);
    const deadline = setTimeout(() => finish(!isPidAlive(pid)), timeoutMs);
    poller.unref?.();
    deadline.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/**
 * Build a supervisor.
 *
 * Every side-effecting dependency is injected so the whole lifecycle -- adopt,
 * refuse, start, stale-shared-memory recovery, health monitoring, shutdown --
 * can be exercised in tests without a real PostgreSQL and without touching the
 * production cluster.
 */
export function createSupervisor(overrides = {}) {
  const env = overrides.env ?? process.env;
  const config = overrides.config ?? buildSupervisorConfig(env, overrides.cwd ?? process.cwd());

  const deps = {
    resolveBinaries: overrides.resolveBinaries ?? resolveBinaries,
    runPgCtlSync: overrides.runPgCtlSync ?? runPgCtlSync,
    probeTcpPort: overrides.probeTcpPort ?? probeTcpPort,
    findPortOwnerPid: overrides.findPortOwnerPid ?? findPortOwnerPid,
    listPostgresProcesses: overrides.listPostgresProcesses ?? listPostgresProcesses,
    killSinglePid: overrides.killSinglePid ?? killSinglePid,
    isPidAlive: overrides.isPidAlive ?? isPidAlive,
    spawnPostgres:
      overrides.spawnPostgres ??
      ((command, args) =>
        spawn(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          windowsHide: true,
          // New process group (DETACHED_PROCESS on Windows). A console control
          // event delivered to this wrapper's console -- the exact mechanism
          // that killed the postmaster with 0xC000013A on 2026-10-05 -- cannot
          // reach it. Not calling `unref()` keeps the exit observable, which is
          // what the health monitor depends on.
          detached: true,
        })),
    readFile: overrides.readFile ?? ((file) => readFileSync(file, "utf8")),
    writeFile: overrides.writeFile ?? ((file, data) => writeFileSync(file, data, "utf8")),
    removeFile: overrides.removeFile ?? ((file) => unlinkSync(file)),
    fileExists: overrides.fileExists ?? ((file) => existsSync(file)),
    mkdirp: overrides.mkdirp ?? ((dir) => mkdirSync(dir, { recursive: true })),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    setInterval: overrides.setInterval ?? setInterval,
    clearInterval: overrides.clearInterval ?? clearInterval,
    onFatal: overrides.onFatal ?? ((code) => process.exit(code)),
  };

  /**
   * Filesystem adapter. Every read, write and delete the supervisor performs
   * goes through here rather than `node:fs` directly, so the ownership and
   * startup paths can be exercised without touching the real data directory.
   */
  const io = {
    fileExists: deps.fileExists,
    readFile: deps.readFile,
    writeFile: deps.writeFile,
    removeFile: deps.removeFile,
  };

  const readOwner = () => readOwnerMarker(config.ownerFile, io);

  const clearOwner = () => {
    try {
      if (io.fileExists(config.ownerFile)) io.removeFile(config.ownerFile);
    } catch {
      /* the marker is an optimisation, never a correctness requirement */
    }
  };

  const log = (message) => {
    const line = `${config.logPrefix} ${redactForLog(message)}`;
    overrides.log ? overrides.log(line) : console.log(line);
  };

  /** Mutable state. `ownedPid` is the single source of truth for "may I kill it". */
  const state = {
    binaries: null,
    child: null,
    ownedPid: null,
    adopted: false,
    shuttingDown: false,
    consecutiveTcpFailures: 0,
    healthTimer: null,
    shutdownPromise: null,
  };

  function readPostmasterPid() {
    if (!deps.fileExists(config.postmasterPidFile)) return null;
    try {
      return parsePostmasterPidFile(deps.readFile(config.postmasterPidFile));
    } catch {
      return null;
    }
  }

  function clusterExists() {
    return (
      deps.fileExists(config.pgVersionFile) && deps.fileExists(config.pgControlFile)
    );
  }

  function pgCtlStatus() {
    if (!state.binaries) return null;
    const result = deps.runPgCtlSync(state.binaries.pgCtl, [
      "status",
      "-D",
      config.dataDir,
    ]);
    if (result.status === null) {
      log(
        `pg_ctl status could not be run (${result.error?.message ?? "no exit status"}); ` +
          `refusing to guess whether a server already owns ${config.dataDir}`,
      );
      return null;
    }
    return result.status;
  }

  function writeOwner(pid) {
    io.writeFile(
      config.ownerFile,
      serializeOwnerMarker(
        {
          pid,
          dataDir: config.dataDir,
          port: config.port,
          wrapperPid: process.pid,
          startedAt: new Date(config.now()).toISOString(),
          wrapperStartEpoch: Math.floor(config.now() / 1000),
        },
      ),
    );
  }

  /**
   * Take over responsibility for a postmaster started by an earlier wrapper.
   *
   * The marker file is what makes a PM2 restart safe: without it the new
   * wrapper would see a healthy cluster, adopt it as "not owned", and then
   * leave it running as an orphan the next time it was stopped.
   */
  function resolveOwnership(livePid) {
    const owner = readOwner();
    if (!owner) {
      log(
        "no ownership marker found; this postmaster was NOT started by this supervisor, so it will be monitored but never stopped here",
      );
      return null;
    }
    if (owner.pid !== livePid) {
      log(
        `ownership marker names pid ${owner.pid} but the live postmaster is pid ${livePid}; treating as not owned`,
      );
      return null;
    }
    if (!deps.isPidAlive(owner.pid)) {
      log(`ownership marker names pid ${owner.pid}, which is not alive; clearing marker`);
      clearOwner();
      return null;
    }
    log(`taking over ownership of pid ${owner.pid} from a previous wrapper (marker match)`);
    return owner.pid;
  }

  // -- startup --------------------------------------------------------------

  async function attemptStart(attemptLabel) {
    const startedAt = config.now();
    log(
      `${attemptLabel}: spawning ${state.binaries.postgres} -D ${config.dataDir} -p ${config.port}`,
    );

    const args = ["-D", config.dataDir, "-p", String(config.port), ...config.postgresFlags];
    const child = deps.spawnPostgres(state.binaries.postgres, args);
    state.child = child;

    if (!child?.pid) {
      throw new Error(`${STARTUP_SPAWN_ERROR}: spawn returned no pid`);
    }
    log(`spawned postmaster pid=${child.pid}`);

    try {
      await waitForReady(child, {
        timeoutMs: config.startupTimeoutMs,
        onServerLine: (line) => log(`pg| ${line}`),
      });
    } catch (err) {
      // A postmaster that printed a readiness timeout may still be alive and
      // holding the port and the shared memory block. Terminate the child this
      // attempt spawned -- and only that child, by PID -- before reporting, so
      // the retry cannot collide with it and so no process is left behind.
      //
      // The old wrapper did none of this: it awaited `pg.start()` with no error
      // handling, so a failed start left whatever it had spawned in place.
      if (child.exitCode === null && child.signalCode === null) {
        log(
          `postmaster pid=${child.pid} did not become ready but is still running; ` +
            `terminating it so nothing is left behind`,
        );
        deps.killSinglePid(child.pid);
        await waitForExit(child, config.failedStartExitGraceMs);
      }
      state.child = null;
      throw err;
    }

    // Requirement: the log line is necessary but not sufficient. Confirm with
    // PostgreSQL's own tooling and a real connection attempt.
    const status = pgCtlStatus();
    const reachable = await deps.probeTcpPort(config.host, config.port);
    if (status !== PG_CTL_RUNNING || !reachable) {
      log(
        `readiness gate failed after the ready line: pg_ctl status=${status} portReachable=${reachable}`,
      );
      await terminateOwned("readiness-gate-failed");
      throw new Error(
        `${STARTUP_TIMEOUT}: pg_ctl status=${status} portReachable=${reachable}`,
      );
    }

    state.ownedPid = child.pid;
    state.adopted = false;
    writeOwner(child.pid);
    log(
      `READY in ${config.now() - startedAt}ms: pid=${child.pid} port=${config.port} dataDir=${config.dataDir} (pg_ctl status=${status}, port reachable)`,
    );
    return child;
  }

  /**
   * Clear stale shared memory, but only after PostgreSQL itself has told us that
   * is the problem, and only for processes that pass `isEligibleStaleProcess`.
   *
   * Attempting this before a failed start would mean killing postgres processes
   * on a guess. Doing it in response to a concrete
   * "pre-existing shared memory block is still in use" is what keeps it targeted.
   */
  async function clearStaleSharedMemory() {
    if (!config.reapStaleProcesses) {
      log(
        "stale shared-memory cleanup is disabled (LEO_DB_REAP_STALE=0); not touching any process",
      );
      // Distinguishable from "looked and found nothing", so the caller does not
      // report a misleading "no orphaned process could be identified".
      return STALE_CLEANUP_DISABLED;
    }

    const portOwner = deps.findPortOwnerPid(config.port);
    const protectedPids = [state.child?.pid, state.ownedPid, portOwner].filter(
      (pid) => typeof pid === "number" && pid > 0,
    );
    const liveness = new Map(
      [state.child?.pid, state.ownedPid, portOwner]
        .filter((pid) => typeof pid === "number" && pid > 0)
        .map((pid) => [pid, true]),
    );

    const candidates = deps.listPostgresProcesses().filter((proc) =>
      isEligibleStaleProcess(proc, { protectedPids, isPidAlive: deps.isPidAlive, liveness }),
    );

    if (candidates.length === 0) {
      // Every postgres.exe on the box still has a live parent, so none of them is
      // a leaked child of a dead postmaster. Something else is holding the block,
      // and guessing would risk an unrelated cluster.
      log(
        "shared memory block is in use, but every postgres.exe process found still has a " +
          "live parent process. None of them is a leaked child of a dead postmaster, so none " +
          "will be terminated. The block may be held by a process outside this data " +
          "directory; PostgreSQL must be investigated before another start attempt.",
      );
      return 0;
    }

    for (const proc of candidates) {
      log(
        `terminating stale postgres.exe pid=${proc.pid} ppid=${proc.parentPid} ` +
          `(parent is not alive, so it is a leaked child holding a shared memory segment)`,
      );
      const killed = deps.killSinglePid(proc.pid);
      if (!killed) log(`failed to terminate stale pid=${proc.pid}`);
    }

    // Give Windows a moment to release the object handles.
    await deps.sleep(1_500);
    return candidates.length;
  }

  async function startOrAdopt() {
    state.binaries = await deps.resolveBinaries(env);
    log(
      `binaries: postgres=${state.binaries.postgres} pg_ctl=${state.binaries.pgCtl}`,
    );
    log(`dataDir=${config.dataDir} port=${config.port}`);

    if (!clusterExists()) {
      // Requirement G. An absent cluster is a deployment mistake, not something
      // to paper over by initialising one: initdb would pick a fresh locale and
      // encoding, and a fresh cluster is not the database the application has
      // been running against for a week.
      throw new Error(
        `no PostgreSQL cluster at ${config.dataDir} (missing PG_VERSION or global/pg_control). ` +
          `This supervisor will not create one: run initdb deliberately if a first-time ` +
          `initialisation is genuinely intended (set LEO_DB_ALLOW_INITDB=1 for that). ` +
          `Existing data directories are never reinitialised or deleted.`,
      );
    }
    log(`existing cluster detected at ${config.dataDir}; skipping initdb (never reinitialise a live data directory)`);
    if (!config.allowInitdb) {
      log("initdb is disabled for this supervisor (LEO_DB_ALLOW_INITDB=0)");
    }

    const status = pgCtlStatus();
    const listening = await deps.probeTcpPort(config.host, config.port);
    const portOwnerPid = listening ? deps.findPortOwnerPid(config.port) : null;
    const recordedPid = readPostmasterPid();

    log(
      `preflight: pg_ctl status=${status} portListening=${listening} portOwnerPid=${portOwnerPid} postmaster.pid=${recordedPid?.pid ?? "(absent)"}`,
    );

    const action = decideStartupAction({ pgCtlStatus: status, portListening: listening });

    if (action === "adopt") {
      const livePid = recordedPid?.pid ?? portOwnerPid;
      state.ownedPid = resolveOwnership(livePid);
      state.adopted = state.ownedPid === null;
      log(
        `adopting the running postmaster (pid=${livePid}); NOT spawning another instance. ` +
          (state.adopted
            ? "Ownership not proven, so this wrapper will monitor only and will not stop it."
            : "Ownership proven, so this wrapper will stop it cleanly on shutdown."),
      );
      return null;
    }

    if (action === "refuse-existing-unhealthy") {
      throw new Error(
        `refusing to start: pg_ctl reports a server owns ${config.dataDir} (status=${status}) but ` +
          `nothing is accepting connections on ${config.host}:${config.port}. ` +
          `It may still be starting, or it is wedged. Starting a second postmaster here would ` +
          `create a duplicate cluster, so this supervisor refuses. Check the postmaster first.`,
      );
    }

    if (action === "refuse-port-conflict") {
      throw new Error(
        `refusing to start: no server owns ${config.dataDir}, but something else is listening on ` +
          `${config.host}:${config.port}${portOwnerPid ? ` (pid ${portOwnerPid})` : ""}. ` +
          `This supervisor never competes for a port it does not own.`,
      );
    }

    if (action === "refuse-pgctl-unavailable") {
      throw new Error(
        `refusing to start: could not determine whether a server already owns ${config.dataDir}. ` +
          `"cannot verify" must never mean "spawn anyway".`,
      );
    }

    log("no server owns this data directory and the port is free; starting");

    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, config.maxStartAttempts); attempt++) {
      try {
        await attemptStart(`start attempt ${attempt}/${config.maxStartAttempts}`);
        return state.child;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        log(`start attempt ${attempt} failed: ${message}`);

        if (message.startsWith(`${STARTUP_SHM_BUSY}:`)) {
          if (attempt >= config.maxStartAttempts) break;

          log(
            "PostgreSQL reports the shared memory block is still held, which means a leaked " +
              "child of a dead postmaster is still mapping it. Identifying provably orphaned " +
              "processes only, then retrying once.",
          );

          const reaped = await clearStaleSharedMemory();

          if (reaped === STALE_CLEANUP_DISABLED) {
            throw new Error(
              `${message} -- and stale shared-memory cleanup is disabled ` +
                `(LEO_DB_REAP_STALE=0), so no process was touched and no retry was made.`,
            );
          }
          if (reaped === 0) {
            throw new Error(
              `${message} -- and no provably-orphaned postgres.exe process could be identified. ` +
                `Refusing to kill processes on a guess.`,
            );
          }

          log(`cleared ${reaped} stale process(es); retrying startup`);
          continue;
        }

        if (attempt >= config.maxStartAttempts) break;
      }
    }

    throw lastError ?? new Error(`${STARTUP_FATAL}: startup failed for an unknown reason`);
  }

  // -- health monitoring ----------------------------------------------------

  function failAndExit(reason, code = 1) {
    if (state.shuttingDown) return;
    log(`FATAL: ${reason}`);
    log(
      "exiting non-zero so PM2 records a real failure instead of reporting a healthy database that is not there",
    );
    state.shuttingDown = true;
    if (state.healthTimer) deps.clearInterval(state.healthTimer);
    clearOwner();
    deps.onFatal(code);
  }

  function startHealthMonitor() {
    if (config.healthIntervalMs <= 0) return;

    state.healthTimer = deps.setInterval(() => {
      if (state.shuttingDown) return;
      void (async () => {
        // Check if our spawned child postmaster has exited
        if (state.child && state.child.exitCode !== null) {
          failAndExit(
            `postmaster pid=${state.child.pid} exited (code=${state.child.exitCode}, signal=${state.child.signalCode})`,
          );
          return;
        }

        // For adopted postmasters (no child handle), verify the owned PID is still alive
        if (state.ownedPid !== null && state.child === null) {
          const alive = deps.isPidAlive(state.ownedPid);
          if (!alive) {
            failAndExit(
              `adopted postmaster pid=${state.ownedPid} is no longer running`,
            );
            return;
          }
        }

        // Primary health check: TCP port connectivity
        const reachable = await deps.probeTcpPort(config.host, config.port);
        if (reachable) {
          if (state.consecutiveTcpFailures > 0) {
            log(`health: port ${config.port} accepting connections again`);
          }
          state.consecutiveTcpFailures = 0;
          return;
        }

        state.consecutiveTcpFailures += 1;
        log(
          `health: nothing accepting connections on ${config.host}:${config.port} ` +
            `(${state.consecutiveTcpFailures}/${config.tcpFailuresBeforeFatal})`,
        );
        if (state.consecutiveTcpFailures >= config.tcpFailuresBeforeFatal) {
          failAndExit(
            `port ${config.port} refused connections ${state.consecutiveTcpFailures} times in a row ` +
              `; treating the database as dead`,
          );
        }
      })();
    }, config.healthIntervalMs);

    state.healthTimer.unref?.();
    log(`health monitor: every ${config.healthIntervalMs}ms (TCP connect + PID liveness)`);
  }

  // -- shutdown -------------------------------------------------------------

  /**
   * Stop the postmaster this supervisor is responsible for.
   *
   * Order matters: `pg_ctl stop -m fast` first, which is a real PostgreSQL
   * shutdown, so WAL is flushed and `postmaster.pid` is removed. A targeted
   * single-PID kill is the last resort only. When the running postmaster is not
   * ours, nothing is touched at all.
   */
  async function terminateOwned(reason) {
    if (state.ownedPid === null) {
      log(`nothing to stop: this supervisor owns no postmaster (reason=${reason})`);
      return false;
    }

    const pid = state.ownedPid;
    log(`stopping owned postmaster pid=${pid} via pg_ctl stop -m fast (reason=${reason})`);

    if (state.binaries) {
      const result = deps.runPgCtlSync(state.binaries.pgCtl, [
        "-D",
        config.dataDir,
        "stop",
        "-m",
        "fast",
        "-w",
        "-t",
        String(Math.max(1, Math.floor(config.stopTimeoutMs / 1000))),
      ]);
      log(
        `pg_ctl stop returned status=${result.status}${
          result.stdout ? ` output=${result.stdout.trim()}` : ""
        }`,
      );
    }

    const exited = state.child
      ? await waitForExit(state.child, config.stopTimeoutMs)
      : await waitForPidGone(pid, config.stopTimeoutMs, deps.isPidAlive);
    if (!exited && deps.isPidAlive(pid)) {
      log(`graceful stop did not complete within ${config.stopTimeoutMs}ms; forcing pid=${pid}`);
      deps.killSinglePid(pid);
      await deps.sleep(500);
    }

    log(`postmaster pid=${pid} stopped (reason=${reason})`);
    state.child = null;
    state.ownedPid = null;
    return true;
  }

  function installSignalHandlers() {
    const handle = (reason, code) => {
      if (state.shutdownPromise) return state.shutdownPromise;
      state.shuttingDown = true;
      log(`received ${reason}; shutting down`);

      state.shutdownPromise = (async () => {
        try {
          if (state.healthTimer) deps.clearInterval(state.healthTimer);
          await terminateOwned(reason);
          clearOwner();
          log(`shutdown complete (${reason})`);
        } catch (err) {
          log(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
        }
        deps.onFatal(code);
        return undefined;
      })();
      return state.shutdownPromise;
    };

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        void handle(signal, 0);
      });
    }

    // An unhandled rejection or exception must not leave the wrapper running over
    // a database it has lost track of. The old wrapper's bare `reject()` landed
    // here and printed `undefined`.
    process.on("unhandledRejection", (reason) => {
      const text =
        reason instanceof Error
          ? `${reason.message}\n${reason.stack ?? ""}`
          : `non-Error rejection: ${String(reason)}`;
      log(`unhandledRejection: ${text}`);
      void handle("unhandledRejection", 1);
    });
    process.on("uncaughtException", (err) => {
      log(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
      void handle("uncaughtException", 1);
    });

    // Last resort for the paths that cannot await, notably a Windows console
    // close. Synchronous, single PID, never an image-name kill.
    process.on("exit", (code) => {
      if (state.ownedPid === null) return;
      const pid = state.ownedPid;
      log(`exiting (code=${code}) with a postmaster still owned; synchronous fallback stop for pid=${pid}`);
      try {
        if (state.binaries) {
          spawnSync(state.binaries.pgCtl, ["-D", config.dataDir, "stop", "-m", "fast", "-w", "-t", "20"], {
            timeout: 25_000,
            windowsHide: true,
          });
        }
        if (isPidAlive(pid)) killSinglePid(pid);
      } catch {
        /* nothing useful can be done from an exit handler */
      }
    });
  }

  // -- entry ----------------------------------------------------------------

  return {
    config,
    state,
    startOrAdopt,
    terminateOwned,
    startHealthMonitor,
    installSignalHandlers,
    async run() {
      installSignalHandlers();
      try {
        await startOrAdopt();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`STARTUP FAILED: ${message}`);
        clearOwner();
        deps.onFatal(1);
        return 1;
      }
      startHealthMonitor();
      log("supervisor running; PostgreSQL is being monitored");
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only status report
// ---------------------------------------------------------------------------

/**
 * Print cluster facts without changing anything. Useful when `leo-db` is down
 * and the question is "is PostgreSQL alive, and who thinks it is".
 */
export async function collectStatusReport(config, overrides = {}) {
  const deps = {
    resolveBinaries: overrides.resolveBinaries ?? resolveBinaries,
    runPgCtlSync: overrides.runPgCtlSync ?? runPgCtlSync,
    probeTcpPort: overrides.probeTcpPort ?? probeTcpPort,
    findPortOwnerPid: overrides.findPortOwnerPid ?? findPortOwnerPid,
    listPostgresProcesses: overrides.listPostgresProcesses ?? listPostgresProcesses,
    isPidAlive: overrides.isPidAlive ?? isPidAlive,
    fileExists: overrides.fileExists ?? ((file) => existsSync(file)),
    readFile: overrides.readFile ?? ((file) => readFileSync(file, "utf8")),
  };

  const binaries = await deps.resolveBinaries(process.env);
  const clusterExists =
    deps.fileExists(config.pgVersionFile) && deps.fileExists(config.pgControlFile);

  let recorded = null;
  if (deps.fileExists(config.postmasterPidFile)) {
    try {
      recorded = parsePostmasterPidFile(deps.readFile(config.postmasterPidFile));
    } catch {
      recorded = null;
    }
  }

  const status = clusterExists
    ? deps.runPgCtlSync(binaries.pgCtl, ["status", "-D", config.dataDir]).status
    : null;
  const listening = await deps.probeTcpPort(config.host, config.port);
  const ownerPid = listening ? deps.findPortOwnerPid(config.port) : null;

  const marker = readOwnerMarker(config.ownerFile, {
    fileExists: deps.fileExists,
    readFile: deps.readFile,
  });

  const processes = deps.listPostgresProcesses();
  const orphans = processes.filter((proc) => !deps.isPidAlive(proc.parentPid));

  return {
    dataDir: config.dataDir,
    port: config.port,
    clusterExists,
    pgCtlStatus: status,
    portListening: listening,
    portOwnerPid: ownerPid,
    postmasterPidFile: recorded,
    ownerMarker: marker,
    postgresProcessCount: processes.length,
    orphanedPostgresProcesses: orphans.map((proc) => ({
      pid: proc.pid,
      parentPid: proc.parentPid,
    })),
    decision: decideStartupAction({ pgCtlStatus: status, portListening: listening }),
  };
}