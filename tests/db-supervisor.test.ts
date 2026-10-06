/**
 * Unit tests for the leo-db supervisor (`scripts/lib/pg-supervisor.mjs`).
 *
 * WHY THESE ARE FAKE-DRIVEN: every assertion here is about DECISION LOGIC --
 * which of two independent probes wins, which processes may be terminated,
 * what exit code the wrapper produces. None of it is about PostgreSQL actually
 * booting. Driving it with fakes makes each rule individually provable and keeps
 * the suite from ever binding a port or touching `.pgdata`.
 *
 * The counterpart `tests/db-supervisor.integration.test.ts` drives the same
 * module against a real throwaway cluster on a random port, so the fakes are
 * checked against reality rather than trusted.
 *
 * Each test below corresponds to a failure that actually occurred on this host
 * on 2026-10-05; the failing behaviour is named in the test name.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- plain ESM JavaScript module, intentionally untyped at source
import {
  PG_CTL_RUNNING,
  PG_SHM_BUSY_LINE,
  PG_READY_LINE,
  STARTUP_SHM_BUSY,
  buildSupervisorConfig,
  classifyPostgresLine,
  createLineBuffer,
  createSupervisor,
  decideStartupAction,
  isEligibleStaleProcess,
  parsePostmasterPidFile,
  redactForLog,
} from "../scripts/lib/pg-supervisor.mjs";

const CWD = "C:\\deploy\\Leo-outreach-tool";

/** A stand-in for a spawned postmaster. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stderr = new EventEmitter();
  stdout = new EventEmitter();
  unref = () => undefined;

  constructor(public pid: number) {
    super();
  }

  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }

  emitStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

interface ScriptedAttempt {
  lines?: string[];
  becomeReady?: boolean;
  exitCode?: number | null;
  closeAfterMs?: number;
  /** Keep the process alive without ever becoming ready. */
  neverExit?: boolean;
}

interface World {
  pgRunning: boolean;
  portOpen: boolean;
  portOwnerPid: number | null;
  livePids: Set<number>;
  processes: Array<{ pid: number; parentPid: number; imageName: string }>;
  attempts: ScriptedAttempt[];
  spawnCount: number;
  spawnCalls: Array<{ bin: string; args: string[] }>;
  children: FakeChild[];
  kills: number[];
  pgCtlCalls: Array<string[]>;
  files: Map<string, string>;
  fatalCodes: number[];
  healthTick: (() => void) | null;
  logLines: string[];
  nextPid: number;
}

function makeWorld(overrides: Partial<World> = {}): World {
  const files = new Map<string, string>();
  files.set(path.join(CWD, ".pgdata", "PG_VERSION"), "18\n");
  files.set(path.join(CWD, ".pgdata", "global", "pg_control"), "control");

  const world: World = {
    pgRunning: false,
    portOpen: false,
    portOwnerPid: null,
    livePids: new Set(),
    processes: [],
    attempts: [],
    spawnCount: 0,
    spawnCalls: [],
    children: [],
    kills: [],
    pgCtlCalls: [],
    files,
    fatalCodes: [],
    healthTick: null,
    logLines: [],
    nextPid: 10_000,
    ...overrides,
  };
  return world;
}

function buildSupervisorWith(world: World, env: Record<string, string> = {}) {
  const config = buildSupervisorConfig(
    { LEO_DB_PORT: "5438", ...env },
    CWD,
  );

  const supervisor = createSupervisor({
    config,
    log: (line: string) => world.logLines.push(line),
    resolveBinaries: async () => ({
      postgres: "C:\\pg\\postgres.exe",
      pgCtl: "C:\\pg\\pg_ctl.exe",
      initdb: "C:\\pg\\initdb.exe",
    }),
    runPgCtlSync: (_bin: string, args: string[]) => {
      world.pgCtlCalls.push(args);
      const isStop = args.includes("stop");
      if (isStop) {
        world.pgRunning = false;
        world.portOpen = false;
        // Real `pg_ctl stop` makes whichever postmaster owns the port exit. The fake
        // must reproduce that, or the supervisor would correctly wait forever for
        // an exit that the fake never delivers.
        for (const pid of [lastSpawnedPid(world), world.portOwnerPid]) {
          if (pid !== null) world.livePids.delete(pid);
        }
        const child = world.children[world.children.length - 1];
        if (child && child.exitCode === null) child.exit(0);
        return { status: 0, stdout: "server stopped", stderr: "", signal: null, error: null };
      }
      return {
        status: world.pgRunning ? PG_CTL_RUNNING : 3,
        stdout: world.pgRunning ? "pg_ctl: server is running" : "pg_ctl: no server running",
        stderr: "",
        signal: null,
        error: null,
      };
    },
    probeTcpPort: async () => world.portOpen,
    findPortOwnerPid: () => world.portOwnerPid,
    listPostgresProcesses: () => world.processes,
    killSinglePid: (pid: number) => {
      world.kills.push(pid);
      world.livePids.delete(pid);
      world.processes = world.processes.filter((p) => p.pid !== pid);
      // A real single-PID kill terminates the process, so the child emits
      // `close`. Without this the supervisor would correctly wait out its full
      // exit grace period.
      const child = world.children.find((c) => c.pid === pid);
      if (child && child.exitCode === null) child.exit(null, "SIGTERM");
      return true;
    },
    isPidAlive: (pid: number) => world.livePids.has(pid),
    spawnPostgres: (bin: string, args: string[]) => {
      world.spawnCount += 1;
      world.spawnCalls.push({ bin, args });
      const child = new FakeChild(world.nextPid++);
      world.children.push(child);

      const script = world.attempts[world.spawnCount - 1] ?? {};
      const plan = (fn: () => void, delay: number) => {
        if (delay <= 0) fn();
        else setTimeout(fn, delay).unref?.();
      };

      setImmediate(() => {
        for (const line of script.lines ?? []) child.emitStderr(`${line}\n`);
        if (script.becomeReady) {
          world.pgRunning = true;
          world.portOpen = true;
          world.portOwnerPid = child.pid;
          world.livePids.add(child.pid);
        }
        if (script.neverExit) {
          /* deliberately left alive so the readiness timeout is what fires */
        } else if (script.lines?.some((l) => l.includes(PG_SHM_BUSY_LINE)) && script.exitCode === undefined) {
          // A real postmaster that hits the shared-memory error exits on its own,
          // without the wrapper having to intervene.
          child.exit(1);
        } else if (script.exitCode !== undefined) {
          plan(() => child.exit(script.exitCode ?? null), script.closeAfterMs ?? 0);
        } else if (!script.becomeReady) {
          plan(() => child.exit(1), script.closeAfterMs ?? 0);
        }
      });

      return child;
    },
    readFile: (file: string) => {
      const value = world.files.get(file);
      if (value === undefined) throw new Error(`ENOENT: ${file}`);
      return value;
    },
    writeFile: (file: string, data: string) => {
      world.files.set(file, data);
    },
    removeFile: (file: string) => {
      world.files.delete(file);
    },
    fileExists: (file: string) => world.files.has(file),
    mkdirp: () => undefined,
    sleep: async () => undefined,
    setInterval: (cb: () => void) => {
      world.healthTick = cb;
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {
      world.healthTick = null;
    },
    onFatal: (code: number) => {
      world.fatalCodes.push(code);
    },
  });

  return supervisor;
}

function lastSpawnedPid(world: World): number | null {
  return world.children.length > 0 ? world.children[world.children.length - 1].pid : null;
}

const READY_SCRIPT: ScriptedAttempt = {
  lines: [
    "2026-10-05 16:20:00.000 -03 [100] LOG:  starting PostgreSQL 18.4",
    `2026-10-05 16:20:01.000 -03 [100] LOG:  ${PG_READY_LINE}`,
  ],
  becomeReady: true,
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// postmaster.pid parsing
// ---------------------------------------------------------------------------

describe("parsePostmasterPidFile", () => {
  it("reads the four fields PostgreSQL writes", () => {
    const parsed = parsePostmasterPidFile(
      "20964\nC:/deploy/Leo-outreach-tool/.pgdata\n1791227518\n5438\n\n",
    );
    expect(parsed).toEqual({
      pid: 20964,
      dataDir: "C:/deploy/Leo-outreach-tool/.pgdata",
      startEpoch: 1791227518,
      port: 5438,
    });
  });

  it("returns null for a truncated or garbage file rather than guessing", () => {
    // The live file on this host during the incident was well formed but named a
    // dead PID, which is why liveness is checked separately.
    expect(parsePostmasterPidFile("20964\n")).toBeNull();
    expect(parsePostmasterPidFile("")).toBeNull();
    expect(parsePostmasterPidFile("not-a-pid\n/data\n1\n5438\n")).toBeNull();
    expect(parsePostmasterPidFile(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Line buffering
// ---------------------------------------------------------------------------

describe("createLineBuffer", () => {
  it("emits complete lines only, and survives the readiness line arriving in two chunks", () => {
    // This is the defect that let the old wrapper hang forever: it matched
    // `chunk.includes('database system is ready to accept connections')`, which
    // silently misses whenever the line straddles two stderr reads.
    const buffer = createLineBuffer();
    const first = buffer.push("LOG:  database system is rea");
    expect(first).toEqual([]);
    const second = buffer.push("dy to accept connections\n");
    expect(second).toEqual(["LOG:  database system is ready to accept connections"]);
  });

  it("flush() releases a trailing line with no newline", () => {
    const buffer = createLineBuffer();
    expect(buffer.push("FATAL:  something bad")).toEqual([]);
    expect(buffer.flush()).toEqual(["FATAL:  something bad"]);
    expect(buffer.flush()).toEqual([]);
  });

  it("strips carriage returns and blank lines", () => {
    const buffer = createLineBuffer();
    expect(buffer.push("a\r\n\r\nb\r\n")).toEqual(["a", "", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Server output classification
// ---------------------------------------------------------------------------

describe("classifyPostgresLine", () => {
  it("recognises the readiness line", () => {
    expect(classifyPostgresLine(`LOG:  ${PG_READY_LINE}`)).toBe("ready");
  });

  it("recognises the shared-memory failure that wedged leo-db for 51 restarts", () => {
    const line = `2026-10-05 15:59:10.634 -03 [24672] FATAL:  ${PG_SHM_BUSY_LINE}`;
    expect(classifyPostgresLine(line)).toBe(STARTUP_SHM_BUSY);
  });

  it("recognises port conflicts and a bad data directory", () => {
    expect(
      classifyPostgresLine(
        "2026-10-05 16:20:00.000 FATAL:  could not create any TCP/IP sockets",
      ),
    ).toBe("port-in-use");
    expect(
      classifyPostgresLine(
        "2026-10-05 16:20:00.000 FATAL:  directory \".pgdata\" is not a data directory",
      ),
    ).toBe("bad-data-directory");
  });

  it("treats any other FATAL as a failure so a wedged start is not waited out", () => {
    expect(classifyPostgresLine("FATAL:  invalid value for parameter")).toBe("fatal");
  });

  it("never treats an unrecognised line as a failure", () => {
    // A false failure would tear down a healthy database, which is strictly worse
    // than waiting.
    expect(classifyPostgresLine("LOG:  checkpoint complete: wrote 31 buffers")).toBeNull();
    expect(classifyPostgresLine("")).toBeNull();
    expect(classifyPostgresLine(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Startup decision table
// ---------------------------------------------------------------------------

describe("decideStartupAction", () => {
  it("adopts when pg_ctl reports a server AND the port answers", () => {
    // THE IDEMPOTENCY TEST: an already-healthy cluster must never be duplicated.
    expect(decideStartupAction({ pgCtlStatus: 0, portListening: true })).toBe("adopt");
  });

  it("refuses when a server owns the data dir but the port is dead", () => {
    // Spawning here is how you get two postmasters on one data directory.
    expect(decideStartupAction({ pgCtlStatus: 0, portListening: false })).toBe(
      "refuse-existing-unhealthy",
    );
  });

  it("refuses when the port is taken by something that is not our cluster", () => {
    expect(decideStartupAction({ pgCtlStatus: 3, portListening: true })).toBe(
      "refuse-port-conflict",
    );
  });

  it("starts only when both probes are clear", () => {
    expect(decideStartupAction({ pgCtlStatus: 3, portListening: false })).toBe("start");
    expect(decideStartupAction({ pgCtlStatus: 4, portListening: false })).toBe("start");
  });

  it("refuses when pg_ctl itself is unusable, rather than spawning on a guess", () => {
    // "cannot verify" must never mean "spawn anyway".
    expect(decideStartupAction({ pgCtlStatus: null, portListening: false })).toBe(
      "refuse-pgctl-unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Stale-process eligibility guard
// ---------------------------------------------------------------------------

describe("isEligibleStaleProcess", () => {
  const ctx = {
    protectedPids: [555, 777],
    isPidAlive: (pid: number) => pid === 4242,
  };

  it("accepts a postgres.exe whose recorded parent is dead", () => {
    // The live case: pid 2784, ppid 28256, where 28256 was the postmaster that
    // died and left its io_worker holding the shared memory segment.
    expect(
      isEligibleStaleProcess({ pid: 2784, parentPid: 28256, imageName: "postgres.exe" }, ctx),
    ).toBe(true);
  });

  it("refuses an io_worker whose postmaster is still alive, even for an unrelated cluster", () => {
    // This is the guard that keeps cleanup from being an image-name kill.
    expect(
      isEligibleStaleProcess({ pid: 9392, parentPid: 4242, imageName: "postgres.exe" }, ctx),
    ).toBe(false);
  });

  it("refuses PIDs the supervisor owns or is starting", () => {
    expect(
      isEligibleStaleProcess({ pid: 555, parentPid: 1, imageName: "postgres.exe" }, ctx),
    ).toBe(false);
    expect(
      isEligibleStaleProcess({ pid: 777, parentPid: 1, imageName: "postgres.exe" }, ctx),
    ).toBe(false);
  });

  it("refuses a process whose parent PID is unknown", () => {
    // Without a parent PID there is no evidence of anything, so nothing is done.
    expect(
      isEligibleStaleProcess({ pid: 3000, parentPid: 0, imageName: "postgres.exe" }, ctx),
    ).toBe(false);
    expect(isEligibleStaleProcess({ pid: 3000, imageName: "postgres.exe" }, ctx)).toBe(false);
  });

  it("refuses any image that is not postgres.exe", () => {
    expect(
      isEligibleStaleProcess({ pid: 3000, parentPid: 1, imageName: "initdb.exe" }, ctx),
    ).toBe(false);
  });

  it("honours an explicit liveness override for protected PIDs", () => {
    expect(
      isEligibleStaleProcess(
        { pid: 2784, parentPid: 28256, imageName: "postgres.exe" },
        { protectedPids: [], isPidAlive: () => false, liveness: new Map([[28256, true]]) },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Log redaction
// ---------------------------------------------------------------------------

describe("redactForLog", () => {
  it("strips credentials from a connection URL", () => {
    expect(
      redactForLog("failed to connect to postgresql://leo:hunter2@127.0.0.1:5438/app"),
    ).toBe("failed to connect to postgresql://leo:<redacted>@127.0.0.1:5438/app");
  });

  it("strips secret-shaped assignments", () => {
    expect(redactForLog("password=hunter2 token: abc123")).toBe(
      "password=<redacted> token: <redacted>",
    );
    expect(redactForLog('api_key = "sk-live-xyz"')).toBe("api_key = <redacted>");
  });

  it("leaves ordinary server output alone", () => {
    const line = "LOG:  database system is ready to accept connections";
    expect(redactForLog(line)).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("buildSupervisorConfig", () => {
  it("defaults to the production port and data directory", () => {
    const config = buildSupervisorConfig({}, CWD);
    expect(config.port).toBe(5438);
    expect(config.dataDir).toBe(path.join(CWD, ".pgdata"));
    expect(config.ownerFile).toBe(path.join(CWD, ".leo-db-owner.json"));
  });

  it("never enables initdb by default", () => {
    expect(buildSupervisorConfig({}, CWD).allowInitdb).toBe(false);
    expect(buildSupervisorConfig({ LEO_DB_ALLOW_INITDB: "1" }, CWD).allowInitdb).toBe(true);
  });

  it("always has a bounded readiness timeout", () => {
    // An unbounded readiness gate is the defect that produced a false "online".
    expect(buildSupervisorConfig({}, CWD).startupTimeoutMs).toBe(60_000);
  });

  it("parses booleans and integers leniently but not wrongly", () => {
    const config = buildSupervisorConfig(
      { LEO_DB_REAP_STALE: "off", LEO_DB_HEALTH_INTERVAL_MS: "not-a-number" },
      CWD,
    );
    expect(config.reapStaleProcesses).toBe(false);
    expect(config.healthIntervalMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Supervisor lifecycle
// ---------------------------------------------------------------------------

describe("supervisor startup", () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
  });

  it("adopts a healthy cluster without spawning a second postmaster", async () => {
    // TEST 1: PostgreSQL already healthy; restarting leo-db must not duplicate it.
    world.pgRunning = true;
    world.portOpen = true;
    world.portOwnerPid = 28256;
    world.livePids.add(28256);
    world.files.set(
      path.join(CWD, ".pgdata", "postmaster.pid"),
      "28256\nC:/deploy/Leo-outreach-tool/.pgdata\n1791227518\n5438\n\n",
    );

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    expect(world.spawnCount).toBe(0);
    expect(supervisor.state.ownedPid).toBeNull();
    expect(world.logLines.join("\n")).toContain("adopting the running postmaster");
  });

  it("refuses to start when the port is held by another process", async () => {
    world.pgRunning = false;
    world.portOpen = true;
    world.portOwnerPid = 4242;

    const supervisor = buildSupervisorWith(world);
    await expect(supervisor.startOrAdopt()).rejects.toThrow(/refusing to start/);
    expect(world.spawnCount).toBe(0);
  });

  it("refuses to start when a server owns the data directory but is not reachable", async () => {
    world.pgRunning = true;
    world.portOpen = false;

    const supervisor = buildSupervisorWith(world);
    await expect(supervisor.startOrAdopt()).rejects.toThrow(/duplicate cluster/);
    expect(world.spawnCount).toBe(0);
  });

  it("refuses to start when it cannot verify ownership at all", async () => {
    const supervisor = buildSupervisorWith(world);
    // Force pg_ctl to be unusable.
    const broken = createSupervisor({
      ...({} as Record<string, never>),
      config: buildSupervisorConfig({}, CWD),
      runPgCtlSync: () => ({ status: null, stdout: "", stderr: "", signal: null, error: new Error("ENOENT") }),
      resolveBinaries: async () => ({ postgres: "p", pgCtl: "c", initdb: "i" }),
      onFatal: (code: number) => world.fatalCodes.push(code),
    });
    await expect(broken.startOrAdopt()).rejects.toThrow(/cannot verify/);
    expect(world.spawnCount).toBe(0);
    expect(supervisor).toBeDefined();
  });

  it("refuses to create a cluster and never runs initdb", async () => {
    // Requirement G. A missing cluster is a deployment mistake, not something to
    // paper over by initialising one.
    world.files.delete(path.join(CWD, ".pgdata", "PG_VERSION"));

    const supervisor = buildSupervisorWith(world);
    await expect(supervisor.startOrAdopt()).rejects.toThrow(/will not create one/);
    expect(world.spawnCount).toBe(0);
  });

  it("starts a cluster that is not running and records ownership", async () => {
    world.attempts = [READY_SCRIPT];

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    expect(world.spawnCount).toBe(1);
    expect(world.spawnCalls[0].args).toEqual([
      "-D",
      path.join(CWD, ".pgdata"),
      "-p",
      "5438",
    ]);
    expect(supervisor.state.ownedPid).toBe(10_000);

    const marker = world.files.get(path.join(CWD, ".leo-db-owner.json"));
    expect(marker).toBeDefined();
    expect(JSON.parse(String(marker))).toMatchObject({
      pid: 10_000,
      port: 5438,
      dataDir: path.join(CWD, ".pgdata"),
    });
  });

  it("confirms readiness with pg_ctl and a TCP connect, not just the log line", async () => {
    // The ready line alone is necessary but not sufficient: it is only trusted
    // once PostgreSQL's own tooling agrees.
    world.attempts = [READY_SCRIPT];
    const supervisor = buildSupervisorWith(world);

    const seen: string[] = [];
    const original = world;
    const withSpy = createSupervisor({
      config: buildSupervisorConfig({}, CWD),
      resolveBinaries: async () => ({ postgres: "p", pgCtl: "c", initdb: "i" }),
      runPgCtlSync: (bin: string, args: string[]) => {
        seen.push(`pg_ctl ${args.join(" ")}`);
        if (args.includes("stop")) return { status: 0, stdout: "", stderr: "", signal: null, error: null };
        return {
          status: original.pgRunning ? PG_CTL_RUNNING : 3,
          stdout: "",
          stderr: "",
          signal: null,
          error: null,
        };
      },
      probeTcpPort: async () => {
        seen.push("tcp-probe");
        return original.portOpen;
      },
      findPortOwnerPid: () => original.portOwnerPid,
      listPostgresProcesses: () => original.processes,
      killSinglePid: (pid: number) => {
        original.kills.push(pid);
        return true;
      },
      isPidAlive: (pid: number) => original.livePids.has(pid),
      spawnPostgres: (bin: string, args: string[]) => {
        const child = new FakeChild(10_000);
        original.children.push(child);
        setImmediate(() => {
          child.emitStderr(`LOG:  ${PG_READY_LINE}\n`);
          original.pgRunning = true;
          original.portOpen = true;
        });
        return child;
      },
      fileExists: (file: string) => original.files.has(file),
      readFile: (file: string) => {
        const v = original.files.get(file);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
      writeFile: (file: string, data: string) => original.files.set(file, data),
      removeFile: (file: string) => original.files.delete(file),
      sleep: async () => undefined,
      onFatal: (code: number) => original.fatalCodes.push(code),
    });

    await withSpy.startOrAdopt();
    expect(seen).toContain("pg_ctl status -D " + path.join(CWD, ".pgdata"));
    expect(seen.filter((entry) => entry === "tcp-probe").length).toBeGreaterThanOrEqual(1);
    expect(supervisor).toBeDefined();
  });

  it("reports a real error, never `undefined`, when the postmaster dies first", async () => {
    // This is the exact content of logs/leo-db-error.log before the fix:
    //   triggerUncaughtException(
    //   ^
    // undefined
    // which came from the library's bare `reject()`. The replacement must carry
    // an actual diagnosis.
    world.attempts = [{ lines: [], exitCode: 1 }];

    const supervisor = buildSupervisorWith(world);
    await expect(supervisor.startOrAdopt()).rejects.toThrow(/postmaster-exited/);
    expect(supervisor.state.ownedPid).toBeNull();
  });

  it("kills the orphan only after the shm failure proves it is the blocker, then retries", async () => {
    world.attempts = [
      { lines: [`FATAL:  ${PG_SHM_BUSY_LINE}`], exitCode: 1 },
      READY_SCRIPT,
    ];
    world.processes = [{ pid: 2784, parentPid: 28256, imageName: "postgres.exe" }];
    // 28256 is NOT in livePids => provably an orphan, exactly the situation that
    // wedged leo-db: postmaster 28256 died leaving io_worker 2784 mapped.

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    expect(world.kills).toEqual([2784]);
    expect(world.spawnCount).toBe(2);
    expect(supervisor.state.ownedPid).toBe(10_001);
    expect(world.logLines.join("\n")).toContain("shared memory block is still held");
  });

  it("leaves live-cluster processes alone and reaps only the dead-parent one", async () => {
    world.attempts = [
      { lines: [`FATAL:  ${PG_SHM_BUSY_LINE}`], exitCode: 1 },
      READY_SCRIPT,
    ];
    world.processes = [
      // Production io_worker 2784; its postmaster 28256 is still ALIVE here.
      { pid: 2784, parentPid: 28256, imageName: "postgres.exe" },
      // An io_worker belonging to a live unrelated test cluster.
      { pid: 9392, parentPid: 4242, imageName: "postgres.exe" },
      // The only provably orphaned one.
      { pid: 29564, parentPid: 9999, imageName: "postgres.exe" },
    ];
    world.livePids.add(4242);
    world.livePids.add(28256);

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    // 2784 and 9392 have live parents and must survive; only 29564 is reaped.
    expect(world.kills).toEqual([29564]);
    expect(world.spawnCount).toBe(2);
  });

  it("refuses to kill anything when no provably orphaned process can be identified", async () => {
    world.attempts = [
      { lines: [`FATAL:  ${PG_SHM_BUSY_LINE}`], exitCode: 1 },
      READY_SCRIPT,
    ];
    world.processes = [{ pid: 9392, parentPid: 4242, imageName: "postgres.exe" }];
    world.livePids.add(4242);

    const supervisor = buildSupervisorWith(world);
    await expect(supervisor.startOrAdopt()).rejects.toThrow(
      /no provably-orphaned postgres\.exe process could be identified/,
    );
    expect(world.kills).toEqual([]);
    expect(world.spawnCount).toBe(1);
  });

  it("never touches a process when stale cleanup is disabled", async () => {
    world.attempts = [
      { lines: [`FATAL:  ${PG_SHM_BUSY_LINE}`], exitCode: 1 },
      READY_SCRIPT,
    ];
    world.processes = [{ pid: 2784, parentPid: 28256, imageName: "postgres.exe" }];

    const supervisor = buildSupervisorWith(world, { LEO_DB_REAP_STALE: "0" });
    await expect(supervisor.startOrAdopt()).rejects.toThrow(
      /stale shared-memory cleanup is disabled/,
    );
    expect(world.kills).toEqual([]);
    expect(world.spawnCount).toBe(1);
  });

  it("gives up with a real message when readiness never arrives", async () => {
    world.attempts = [{ lines: [], neverExit: true }];

    const supervisor = buildSupervisorWith(world, {
      LEO_DB_START_TIMEOUT_MS: "40",
      LEO_DB_FAILED_EXIT_GRACE_MS: "200",
      // One attempt, so the surfaced error is the timeout itself and not the
      // result of a retry with an unscripted second attempt.
      LEO_DB_MAX_START_ATTEMPTS: "1",
    });
    await expect(supervisor.startOrAdopt()).rejects.toThrow(/readiness-timeout/);
    expect(supervisor.state.ownedPid).toBeNull();
    // A postmaster that timed out but was still alive must not be left behind.
    expect(world.kills).toEqual([10_000]);
    expect(world.logLines.join("\n")).toContain(
      "did not become ready but is still running",
    );
  });
});

// ---------------------------------------------------------------------------
// Health monitoring
// ---------------------------------------------------------------------------

describe("supervisor health monitoring", () => {
  let world: World;

  beforeEach(async () => {
    world = makeWorld();
    world.attempts = [READY_SCRIPT];
  });

  it("does nothing while the database is healthy", async () => {
    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();
    supervisor.startHealthMonitor();

    world.healthTick?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(world.fatalCodes).toEqual([]);
  });

  it("exits non-zero when the postmaster dies -- this is the false-online bug", async () => {
    // Before the fix, `setInterval(() => {}, 1 << 30)` held the process open for
    // 61 minutes over a database that had already been gone since 11:41.
    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();
    supervisor.startHealthMonitor();

    world.children[0].exit(1, null);
    world.pgRunning = false;
    world.healthTick?.();
    await new Promise((r) => setTimeout(r, 10));

    expect(world.fatalCodes).toEqual([1]);
    expect(world.logLines.join("\n")).toContain("postmaster pid=10000 exited");
  });

  it("exits non-zero when the adopted postmaster is no longer alive", async () => {
    // Setup: adopt an existing healthy postmaster
    world.pgRunning = true;
    world.portOpen = true;
    world.portOwnerPid = 28256;
    world.livePids.add(28256);
    world.files.set(
      path.join(CWD, ".pgdata", "postmaster.pid"),
      "28256\nC:/deploy/Leo-outreach-tool/.pgdata\n1791227518\n5438\n\n",
    );
    // Ownership marker so the supervisor knows it owns this postmaster
    world.files.set(
      path.join(CWD, ".leo-db-owner.json"),
      JSON.stringify({
        pid: 28256,
        dataDir: path.join(CWD, ".pgdata"),
        port: 5438,
        wrapperPid: 12345,
        startedAt: new Date().toISOString(),
        wrapperStartEpoch: Date.now(),
      }, null, 2) + "\n",
    );

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();
    supervisor.startHealthMonitor();

    // Verify ownership was established
    expect(supervisor.state.ownedPid).toBe(28256);

    // Simulate the postmaster dying
    world.livePids.delete(28256);
    world.healthTick?.();
    await new Promise((r) => setTimeout(r, 10));

    expect(world.fatalCodes).toEqual([1]);
    expect(world.logLines.join("\n")).toContain("adopted postmaster pid=28256 is no longer running");
  });

  it("tolerates a single refused connect but fails after the configured streak", async () => {
    const supervisor = buildSupervisorWith(world, { LEO_DB_TCP_FAILURES: "3" });
    await supervisor.startOrAdopt();
    supervisor.startHealthMonitor();

    world.portOpen = false;
    for (let i = 0; i < 2; i++) {
      world.healthTick?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(world.fatalCodes).toEqual([]);

    world.healthTick?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(world.fatalCodes).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("supervisor shutdown", () => {
  let world: World;

  beforeEach(async () => {
    world = makeWorld();
    world.attempts = [READY_SCRIPT];
  });

  it("stops a postmaster it started, via pg_ctl rather than a kill", async () => {
    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    await supervisor.terminateOwned("SIGTERM");

    const stopCall = world.pgCtlCalls.find((args) => args.includes("stop"));
    expect(stopCall).toBeDefined();
    expect(stopCall).toContain("-m");
    expect(stopCall).toContain("fast");
    expect(world.kills).toEqual([]);
    expect(supervisor.state.ownedPid).toBeNull();
  });

  it("never stops a postmaster it does not own", async () => {
    world.pgRunning = true;
    world.portOpen = true;
    world.portOwnerPid = 28256;
    world.livePids.add(28256);

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    const stopped = await supervisor.terminateOwned("SIGTERM");

    expect(stopped).toBe(false);
    expect(world.pgCtlCalls.some((args) => args.includes("stop"))).toBe(false);
    expect(world.kills).toEqual([]);
  });

  it("takes over a postmaster a previous wrapper started, then stops it cleanly", async () => {
    // This is what makes `pm2 restart leo-db` safe: without the ownership marker
    // the new wrapper would adopt the server as "not owned" and orphan it.
    world.pgRunning = true;
    world.portOpen = true;
    world.portOwnerPid = 28256;
    world.livePids.add(28256);
    world.files.set(
      path.join(CWD, ".leo-db-owner.json"),
      JSON.stringify({
        pid: 28256,
        dataDir: path.join(CWD, ".pgdata"),
        port: 5438,
        wrapperPid: 1234,
      }),
    );

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    expect(supervisor.state.ownedPid).toBe(28256);
    expect(world.spawnCount).toBe(0);

    await supervisor.terminateOwned("SIGTERM");
    expect(world.pgCtlCalls.some((args) => args.includes("stop"))).toBe(true);
  });

  it("discards a stale marker that names a dead PID", async () => {
    world.pgRunning = true;
    world.portOpen = true;
    world.portOwnerPid = 28256;
    world.livePids.add(28256);
    // postmaster.pid names 20964, exactly as it does on this host right now,
    // because that postmaster died and the file was never cleaned up.
    world.files.set(
      path.join(CWD, ".pgdata", "postmaster.pid"),
      "20964\nC:/deploy/Leo-outreach-tool/.pgdata\n1791227518\n5438\n\n",
    );
    world.files.set(
      path.join(CWD, ".leo-db-owner.json"),
      JSON.stringify({ pid: 20964, dataDir: path.join(CWD, ".pgdata"), port: 5438 }),
    );
    // 20964 is dead; 28256 is the postmaster that is actually listening.
    world.livePids.delete(20964);

    const supervisor = buildSupervisorWith(world);
    await supervisor.startOrAdopt();

    expect(supervisor.state.ownedPid).toBeNull();
    expect(world.files.has(path.join(CWD, ".leo-db-owner.json"))).toBe(false);
    expect(world.logLines.join("\n")).toContain(
      "ownership marker names pid 20964, which is not alive; clearing marker",
    );
  });
});