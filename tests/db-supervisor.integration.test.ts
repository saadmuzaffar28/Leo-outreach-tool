/**
 * Integration tests: the supervisor against a REAL PostgreSQL postmaster.
 *
 * `tests/db-supervisor.test.ts` proves the decision logic with fakes. Fakes
 * agree with whatever they were written to agree with, so on their own they
 * cannot show that the supervisor actually starts a cluster, stops it cleanly,
 * or leaves no orphaned io_workers behind. That is exactly the class of bug this
 * whole change exists to fix -- 30 orphaned `postgres.exe` io_worker processes
 * and a postmaster killed by a console control event -- so it has to be
 * demonstrated against the real thing.
 *
 * SAFETY: every test here runs against a THROWAWAY cluster in a fresh temp
 * directory on a kernel-assigned free port. It never reads or writes
 * `.pgdata`, never connects to 5438, and never touches the application database.
 * Teardown is defensive because a leaked throwaway cluster is worse than a
 * failed assertion.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error -- plain ESM JavaScript module
import { createSupervisor } from "../scripts/lib/pg-supervisor.mjs";
// @ts-expect-error -- plain ESM JavaScript module
import binaries from "../node_modules/@embedded-postgres/windows-x64/dist/index.js";

const READY_LINE = "database system is ready to accept connections";

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
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

/** Count live `postgres.exe` processes whose parent is dead. */
function orphanedPostgresPids(): number[] {
  if (process.platform !== "win32") return [];
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue';" +
        `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |` +
        " ForEach-Object { '{0}|{1}' -f $_.ProcessId,$_.ParentProcessId }",
    ],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  const all = new Map<number, number>();
  for (const line of String(ps.stdout ?? "").split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split("|");
    const p = Number.parseInt(pid, 10);
    if (Number.isInteger(p)) all.set(p, Number.parseInt(ppid, 10));
  }
  const orphans: number[] = [];
  for (const [pid, ppid] of all) {
    try {
      process.kill(ppid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EPERM") continue;
      orphans.push(pid);
    }
  }
  return orphans;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Build a supervisor wired to a throwaway cluster.
 *
 * Only `cwd` and the two env values differ from production; every code path under
 * test is the real one.
 */
function makeSupervisor(dataDir: string, port: number, ownerFile: string) {
  const config = {
    ...buildConfig(dataDir, port, ownerFile),
  };
  return createSupervisor({
    config,
    log: () => {},
    onFatal: (code: number) => {
      throw new Error(`supervisor exited with ${code}`);
    },
  });
}

// Mirrors buildSupervisorConfig() without importing buildSupervisorConfig from
// an untyped module twice; kept explicit so the values under test are visible.
function buildConfig(dataDir: string, port: number, ownerFile: string) {
  return {
    port,
    host: "127.0.0.1",
    dataDir,
    pgVersionFile: join(dataDir, "PG_VERSION"),
    pgControlFile: join(dataDir, "global", "pg_control"),
    postmasterPidFile: join(dataDir, "postmaster.pid"),
    ownerFile,
    startupTimeoutMs: 60_000,
    stopTimeoutMs: 30_000,
    failedStartExitGraceMs: 15_000,
    healthIntervalMs: 0,
    tcpFailuresBeforeFatal: 3,
    maxStartAttempts: 2,
    reapStaleProcesses: true,
    allowInitdb: false,
    postgresFlags: [],
    logPrefix: "[test-db]",
    now: () => Date.now(),
  };
}

let dataDir: string;
let port: number;
let ownerFile: string;

beforeAll(async () => {
  port = await findFreePort();
  dataDir = mkdtempSync(join(tmpdir(), "leo-supervisor-pg-"));
  ownerFile = join(dataDir, "owner-marker.json");

  // Create the cluster with initdb ONCE, outside the supervisor. The supervisor
  // is required never to run initdb, so the fixture must not depend on it.
  execFileSync(
    binaries.initdb,
    ["-D", dataDir, "-U", "postgres", "--auth=trust", "--encoding=UTF8"],
    { encoding: "utf8", timeout: 120_000, windowsHide: true },
  );
  expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(true);
  expect(existsSync(join(dataDir, "global", "pg_control"))).toBe(true);
});

afterEach(async () => {
  // Defensive: a test that threw mid-lifecycle could leave a postmaster up.
  const ps = spawnSync(
    binaries.pgCtl,
    ["-D", dataDir, "stop", "-m", "fast", "-w", "-t", "20"],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  expect([0, 1, 3]).toContain(ps.status);
});

afterAll(async () => {
  const ps = spawnSync(
    binaries.pgCtl,
    ["-D", dataDir, "stop", "-m", "immediate", "-w", "-t", "10"],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  void ps;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

describe("supervisor against a real postmaster", () => {
  it("TEST 1: starts a real cluster and reaches readiness", async () => {
    const supervisor = makeSupervisor(dataDir, port, ownerFile);
    await supervisor.startOrAdopt();

    expect(supervisor.state.ownedPid).toBeGreaterThan(0);
    expect(isPidAlive(supervisor.state.ownedPid as number)).toBe(true);
    expect(existsSync(ownerFile)).toBe(true);

    const status = spawnSync(binaries.pgCtl, ["status", "-D", dataDir], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("server is running");

    await supervisor.terminateOwned("test");
  }, 120_000);

  it("TEST 1b: a second supervisor adopts the running cluster instead of duplicating it", async () => {
    const first = makeSupervisor(dataDir, port, ownerFile);
    await first.startOrAdopt();
    const ownedPid = first.state.ownedPid;

    // A PM2 restart is modelled as: old wrapper gone, new wrapper, same cluster.
    // The ownership marker is what tells the new wrapper it may stop this server.
    const second = makeSupervisor(dataDir, port, ownerFile);
    await second.startOrAdopt();

    expect(second.state.ownedPid).toBe(ownedPid);
    // pg_ctl still reports exactly one server, and the postmaster PID is
    // unchanged: no second instance was spawned.
    const pidFile = spawnSync(binaries.pgCtl, ["status", "-D", dataDir], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(pidFile.status).toBe(0);
    expect(second.state.child).toBeNull();

    await second.terminateOwned("test");
  }, 120_000);

  it("TEST 2: shutdown leaves no orphaned postgres.exe behind", async () => {
    const before = orphanedPostgresPids();

    const supervisor = makeSupervisor(dataDir, port, ownerFile);
    await supervisor.startOrAdopt();
    const pid = supervisor.state.ownedPid as number;
    expect(isPidAlive(pid)).toBe(true);

    await supervisor.terminateOwned("SIGTERM");

    expect(isPidAlive(pid)).toBe(false);
    expect(existsSync(join(dataDir, "postmaster.pid"))).toBe(false);

    // Clean shutdown means no crash recovery on the next boot. `pg_controldata`
    // is not available in this build, so assert via the next clean start instead:
    // a clean stop leaves the cluster immediately startable.
    const restarted = makeSupervisor(dataDir, port, ownerFile);
    await restarted.startOrAdopt();
    await restarted.terminateOwned("test");

    const after = orphanedPostgresPids();
    // No NEW orphans attributable to these clusters.
    expect(after.filter((pid) => !before.includes(pid))).toEqual([]);
  }, 180_000);

  it("TEST 4: detects that the postmaster died and refuses to stay falsely healthy", async () => {
    const config = { ...buildConfig(dataDir, port, ownerFile), healthIntervalMs: 250 };
    const fatalCodes: number[] = [];
    const supervisor = createSupervisor({
      config,
      log: () => {},
      onFatal: (code: number) => fatalCodes.push(code),
    });

    await supervisor.startOrAdopt();
    const pid = supervisor.state.ownedPid as number;

    // Kill the postmaster out from under the supervisor, exactly as the
    // 0xC000013A console event did.
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 1200));

    supervisor.startHealthMonitor();
    await new Promise((r) => setTimeout(r, 1500));

    // The wrapper reports failure rather than continuing as a healthy DB.
    expect(fatalCodes).toContain(1);
  }, 120_000);

  it("TEST 5: repeated start/stop cycles do not accumulate postgres.exe processes", async () => {
    const countPostgres = () => {
      const ps = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='SilentlyContinue';" +
            "(Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\").Count",
        ],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
      );
      return Number.parseInt(String(ps.stdout ?? "").trim(), 10) || 0;
    };

    const before = countPostgres();
    const orphansBefore = orphanedPostgresPids().length;

    for (let i = 0; i < 4; i++) {
      const supervisor = makeSupervisor(dataDir, port, ownerFile);
      await supervisor.startOrAdopt();
      await supervisor.terminateOwned(`cycle-${i}`);
    }

    const after = countPostgres();
    const orphansAfter = orphanedPostgresPids().length;

    // Four clean cycles must not leave a single extra process behind.
    expect(after).toBeLessThanOrEqual(before);
    expect(orphansAfter).toBeLessThanOrEqual(orphansBefore);
  }, 300_000);

  it("TEST 6: an existing cluster is never reinitialised or modified", async () => {
    // A marker file inside the data directory that initdb would never create.
    const sentinel = join(dataDir, "DO-NOT-DELETE.txt");
    const { writeFileSync, statSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(sentinel, "if this file is gone, the cluster was reinitialised");
    const beforeMtime = statSync(sentinel).mtimeMs;

    for (let i = 0; i < 2; i++) {
      const supervisor = makeSupervisor(dataDir, port, ownerFile);
      await supervisor.startOrAdopt();
      await supervisor.terminateOwned("test");
    }

    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(true);
    expect(statSync(sentinel).mtimeMs).toBe(beforeMtime);
  }, 180_000);

  it("TEST 7: refuses to create a cluster when the data directory has none", async () => {
    const missing = mkdtempSync(join(tmpdir(), "leo-supervisor-empty-"));
    try {
      const supervisor = makeSupervisor(join(missing, "nope"), port, ownerFile);
      await expect(supervisor.startOrAdopt()).rejects.toThrow(/will not create one/);
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses to start when something else already owns the port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      const supervisor = makeSupervisor(dataDir, port, ownerFile);
      await expect(supervisor.startOrAdopt()).rejects.toThrow(/refusing to start/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);
});

describe("readiness detection against a real postmaster", () => {
  it("confirms readiness through the actual server log line", async () => {
    const supervisor = makeSupervisor(dataDir, port, ownerFile);
    const lines: string[] = [];
    const config = buildConfig(dataDir, port, ownerFile);
    const instrumented = createSupervisor({
      config,
      log: (line: string) => lines.push(line),
      onFatal: (code: number) => {
        throw new Error(`exited ${code}`);
      },
    });

    await instrumented.startOrAdopt();
    expect(lines.join("\n")).toContain(READY_LINE);
    await supervisor.terminateOwned("noop");
    await instrumented.terminateOwned("test");
  }, 120_000);
});