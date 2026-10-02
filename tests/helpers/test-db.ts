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
 * touches the application's database on :5438.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
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