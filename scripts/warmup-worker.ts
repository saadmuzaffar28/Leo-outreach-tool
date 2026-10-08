import "dotenv/config";
import "./worker-alias";
import { runWarmupWorker } from "../src/lib/warmup/worker";

/**
 * Dedicated mailbox warm-up worker.
 *
 * Deliberately a SEPARATE process from the campaign send-queue worker
 * (`scripts/worker.ts`). Warm-up must never be able to stall, starve, or delay
 * real campaign sends, and campaign sending must keep working even if warm-up
 * is misbehaving. One process per role, run by PM2, is the cheapest way to make
 * that guarantee structural rather than a matter of careful code.
 *
 * Safe to run more than one instance: jobs are claimed with a lease and a job
 * cannot be executed twice.
 */
runWarmupWorker()
  .then(() => process.exit(0))
  .catch((err) => {
    // Deliberately no credential-adjacent detail in this line: `err` could carry
    // a connection string or auth failure text from a provider.
    console.error("[warmup-worker] fatal", err instanceof Error ? err.message : "unknown error");
    process.exit(1);
  });