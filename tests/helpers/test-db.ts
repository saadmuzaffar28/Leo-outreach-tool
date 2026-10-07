/**
 * Integration test harness: a real, throwaway PostgreSQL instance.
 *
 * WHY THIS EXISTS: the load-bearing claim of this feature is that the shared
 * per-mailbox daily ceiling is ATOMIC — that two workers reserving slots
 * concurrently cannot together exceed the limit. That claim cannot be proved
 * against a mock. A fake `updateMany` would simply agree with whatever the
 * fake was written to agree with. So these tests run against a real Postgres
 * started by embedded-postgres, using real transactions and real row locks.
 *
 * The database is created fresh per test file and deleted afterwards. It never
 * touches the application's database on :5438, never touches the LeoPostgres
 * Windows Service, and never touches its cluster at
 * C:\deploy\Leo-outreach-tool.old\.pgdata: every cluster here is initialised
 * from scratch in a temp directory and bound to a kernel-assigned free port.
 *
 * ---------------------------------------------------------------------------
 * WHY TEARDOWN REAPS THE PROCESS TREE ITSELF
 * ---------------------------------------------------------------------------
 * `EmbeddedPostgres.stop()` on Windows does, verbatim
 * (node_modules/embedded-postgres/dist/index.js:243-260):
 *
 *     yield new Promise((resolve) => {
 *         this.process?.on('exit', resolve);            // <-- only the parent
 *         spawn('taskkill', ['/pid', pid, '/f', '/t']); // <-- not awaited
 *     });
 *
 * It therefore resolves the moment the POSTMASTER exits. Nothing waits for,
 * or verifies, the rest of the tree, and once the postmaster is gone its
 * children are re-parented — a walk started afterwards can no longer tell that
 * they were ours. `stopTestDatabase()` used to take `stop()` at its word and
 * go straight to deleting the data directory, which is why full suite runs
 * left stray `postgres.exe --forkchild="io_worker"` processes in the test
 * session: dead parent, no listener, no owner.
 *
 * Measured here: a plain `node` process that awaits `stop()` and then idles
 * reaped its own 9-process tree 5 times out of 5, but `npm run test` left
 * 0-4 orphans per run. The difference is timing — vitest tears the worker down
 * as soon as `afterAll` returns, racing the fire-and-forget `taskkill`. So
 * teardown does not trust `stop()`: it snapshots this cluster's tree BEFORE
 * stopping (while the postmaster is still alive, so the ancestry exists) and
 * reaps whatever still belongs to it afterwards.
 *
 * SCOPE: the snapshot is rooted at the PID this file spawned and each entry is
 * pinned by PID *and* creation time, so a recycled PID cannot be mistaken for
 * ours. It structurally cannot reach LeoPostgres (different postmaster, Session
 * 0, different binary path), a sibling test cluster (different postmaster), or
 * any non-postgres process.
 *
 * The suite must never point these throwaway clusters at the production
 * database, and production must never be stopped or restarted from here.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const USER = "postgres";
const PASSWORD = "password";

let pg: EmbeddedPostgres | null = null;
let dataDir: string | null = null;
let port: number | null = null;

/**
 * Ask the OS for a free TCP port.
 *
 * A hard-coded port does not work here. Vitest runs test FILES in parallel, so
 * two integration files booting a cluster on the same port collide: one wins,
 * the other's postmaster cannot bind, and it hangs rather than failing fast --
 * which presents as an unexplained 120s hook timeout with no error at all.
 * Asking the kernel for a free port removes the failure mode entirely.
 *
 * There is an unavoidable race between closing this probe socket and Postgres
 * binding it, but the window is tiny and both ports are in the dynamic range.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("Could not determine a free port"));
        return;
      }
      const { port: found } = address;
      srv.close(() => resolve(found));
    });
  });
}

export async function startTestDatabase(): Promise<string> {
  if (pg && port) return urlFor(port);

  port = await findFreePort();
  dataDir = mkdtempSync(join(tmpdir(), "warmup-pg-"));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: USER,
    password: PASSWORD,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("warmup_test");

  const url = urlFor(port);
  pushSchema(url);
  // Must happen BEFORE the Prisma client is constructed; callers therefore
  // import `@/lib/prisma` dynamically after awaiting this function.
  process.env.DATABASE_URL = url;
  return url;
}

function urlFor(p: number): string {
  return `postgresql://${USER}:${PASSWORD}@localhost:${p}/warmup_test`;
}

/** Push the real Prisma schema so tests exercise the actual tables/constraints. */
function pushSchema(url: string): void {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    shell: true,
  });
}

export async function stopTestDatabase(): Promise<void> {
  // Disconnect Prisma FIRST. Postgres shuts its sockets the moment the server
  // stops, and leaving a live pool attached turns a clean teardown into a pile
  // of ECONNRESET errors that get reported as suite failures.
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  } catch {
    /* never constructed, or already closed */
  }

  if (pg) {
    // Snapshot the tree while the postmaster is still alive: afterwards its
    // children are re-parented and there is no way left to recognise them as
    // ours. Teardown must never throw, so any failure here degrades to the
    // old behaviour (stop only) rather than failing the suite.
    const tree = captureClusterTree();

    // Teardown must never throw. A failure here would be reported as a suite
    // failure and, worse, would skip the temp-directory cleanup below and leak
    // a running cluster. Losing a temp dir is strictly better than that.
    try {
      await pg.stop();
    } catch {
      /* the cluster is a throwaway; the OS reclaims it on exit */
    } finally {
      pg = null;
      port = null;
    }

    await reapClusterTree(tree);
  }

  if (dataDir) {
    const dir = dataDir;
    dataDir = null;
    // Windows holds file handles briefly after the server exits, so the first
    // rmdir can fail with EBUSY even though the cluster is gone. Retry rather
    // than fail the suite over a temp directory -- the OS reclaims it anyway.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Process-tree snapshot and reap (Windows only -- see file header)
 * ------------------------------------------------------------------ */

/** One row of `Win32_Process`. `t` is CreationDate as a FILETIME STRING. */
type WinProc = {
  /** ProcessId */
  p: number;
  /** ParentProcessId */
  pp: number;
  /** Name */
  n: string;
  /** CreationDate.ToFileTimeUtc(), stringified on purpose: a FILETIME exceeds
   *  Number.MAX_SAFE_INTEGER, so as a JSON number it would lose precision and
   *  weaken the identity check below. */
  t: string;
  /** CommandLine */
  cl: string;
};

/**
 * Enumerate processes through CIM rather than `wmic` (removed from current
 * Windows 11 builds) or `tasklist` (no parent PID). Output is JSON so parsing
 * never depends on column spacing or console code pages.
 */
const LIST_PROCESSES_PS = `
Get-CimInstance Win32_Process | ForEach-Object {
  $created = '';
  if ($_.CreationDate) { $created = [string]$_.CreationDate.ToFileTimeUtc() }
  [pscustomobject]@{
    p  = [int]$_.ProcessId
    pp = [int]$_.ParentProcessId
    n  = [string]$_.Name
    t  = $created
    cl = [string]$_.CommandLine
  }
} | ConvertTo-Json -Compress`;

function listProcesses(): WinProc[] {
  let raw = "";
  try {
    raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", LIST_PROCESSES_PS],
      { encoding: "utf8", windowsHide: true, timeout: 30000 }
    );
  } catch {
    // A diagnostic must never fail a suite. If enumeration is unavailable the
    // harness simply falls back to trusting pg.stop(), i.e. the old behaviour.
    return [];
  }
  if (!raw.trim()) return [];

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const procs: WinProc[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.p !== "number" || typeof row.pp !== "number") continue;
    procs.push({
      p: row.p,
      pp: row.pp,
      n: typeof row.n === "string" ? row.n : "",
      t: typeof row.t === "string" ? row.t : "",
      cl: typeof row.cl === "string" ? row.cl : "",
    });
  }
  return procs;
}

/**
 * Every `postgres.exe` descending from `rootPid`, as pid -> creation time.
 * Descendants are found by walking ParentProcessId, so sibling clusters started
 * by other parallel vitest files are excluded by construction.
 */
function clusterTree(procs: WinProc[], rootPid: number): Map<number, string> {
  const byPid = new Map<number, WinProc>(procs.map((row) => [row.p, row]));
  const members = new Set<number>([rootPid]);

  let grew = true;
  while (grew) {
    grew = false;
    for (const row of procs) {
      if (members.has(row.p) || !members.has(row.pp)) continue;
      members.add(row.p);
      grew = true;
    }
  }

  const tree = new Map<number, string>();
  members.forEach((pid) => {
    const row = byPid.get(pid);
    if (row && row.n.toLowerCase() === "postgres.exe") tree.set(pid, row.t);
  });
  return tree;
}

/** The postmaster PID this harness actually spawned, if still readable. */
function spawnedPostmasterPid(): number | null {
  try {
    const pid = (pg as unknown as { process?: { pid?: number } } | null)?.process?.pid;
    return typeof pid === "number" && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function captureClusterTree(): Map<number, string> {
  try {
    const pid = spawnedPostmasterPid();
    if (pid === null) {
      debugTeardown("capture: postmaster pid unreadable");
      return new Map();
    }
    const procs = listProcesses();
    debugTeardown(`capture: enumerate=${procs.length} postmaster=${pid}`);
    return clusterTree(procs, pid);
  } catch (err) {
    debugTeardown(`capture: threw ${String(err)}`);
    return new Map();
  }
}

/** Entries that are STILL ours. Two groups:
 *  1. members of the pre-stop snapshot still alive and identical (PID + creation
 *     time -- a recycled PID is never touched);
 *  2. anything `postgres.exe` whose ParentProcessId landed inside that snapshot.
 *     Group 2 catches processes the postmaster (re)spawned after the snapshot:
 *     teardown measures show io_workers racing taskkill get re-spawned right as
 *     the postmaster dies. Windows keeps the dead parent's PID in
 *     ParentProcessId, so those stragglers stay identifiable even though their
 *     parent no longer exists -- and a live sibling cluster is never matched,
 *     because its ancestors are its own node worker, not ours. */
function liveMembers(expected: Map<number, string>): number[] {
  const procs = listProcesses();
  if (procs.length === 0) return [];
  const byPid = new Map<number, WinProc>(procs.map((row) => [row.p, row]));
  const alive: number[] = [];
  const inResult = new Set<number>();

  expected.forEach((created, pid) => {
    const row = byPid.get(pid);
    if (row && row.t === created && row.n.toLowerCase() === "postgres.exe") {
      alive.push(pid);
      inResult.add(pid);
    }
  });

  for (const row of procs) {
    if (row.n.toLowerCase() !== "postgres.exe") continue;
    if (inResult.has(row.p)) continue;
    if (expected.has(row.pp)) {
      alive.push(row.p);
      inResult.add(row.p);
    }
  }
  return alive;
}

const TEARDOWN_LOG = join(tmpdir(), "leo-test-db-teardown.log");

/** Anomalies only -- a clean teardown writes nothing at all. */
function logTeardown(message: string): void {
  try {
    appendFileSync(TEARDOWN_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
  } catch {
    /* diagnostics must never break a suite */
  }
}

/** Set LEO_TEST_DB_DEBUG=1 to trace every teardown's capture/reap decisions. */
function debugTeardown(message: string): void {
  if (process.env.LEO_TEST_DB_DEBUG === "1") logTeardown(`DEBUG ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reap anything that `pg.stop()` failed to take with it, then verify. Verified
 * rather than assumed: the whole point of this routine is that "stop() returned"
 * is not evidence that the cluster is gone.
 *
 * Loops instead of doing one pass, because teardown measurements show io_workers
 * racing taskkill: the postmaster (re)spawns one right as it is being killed,
 * so a single post-stop scan can legitimately show nothing at first and another
 * member appear a moment later.
 */
async function reapClusterTree(expected: Map<number, string>): Promise<void> {
  if (expected.size === 0) {
    debugTeardown("reap: nothing captured; falling back to stop()'s own cleanup");
    return;
  }

  for (let round = 0; ; round++) {
    const survivors = liveMembers(expected);
    debugTeardown(`reap: round=${round} expected=${expected.size} survivors=${survivors.length}`);
    if (survivors.length === 0) {
      if (round > 0) debugTeardown(`reap: clean after round ${round}`);
      return; // the common case: stop() got everything
    }

    const detail = survivors
      .map((pid) => `${pid} ${listProcesses().find((row) => row.p === pid)?.cl ?? ""}`.trim())
      .join(" | ");
    logTeardown(`round ${round}: ${survivors.length} member(s) survived pg.stop(): ${detail}`);

    for (const pid of survivors) {
      try {
        process.kill(pid);
      } catch {
        /* already gone, or not ours to begin with */
      }
    }

    if (round >= 20) {
      logTeardown(`reap: giving up -- ${survivors.length} still alive after ${round} round(s)`);
      return;
    }
    await sleep(200);
  }
}
