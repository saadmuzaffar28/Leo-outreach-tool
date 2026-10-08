import "dotenv/config";
import "./worker-alias";
import { runBatchWorker, runVerificationWorker } from "../src/lib/verification/worker";

// `--batch=<id>` runs ONE batch to completion with a batch-scoped claim:
// legacy (batchId null) jobs are structurally invisible to it, and only jobs
// whose batch is actually "running" are claimed (start the batch first via
// POST /api/email-verification/batches/:id/start). Without the flag this is
// the unchanged global worker.
const batchArg = process.argv.find((arg) => arg.startsWith("--batch="));
const batchId = batchArg ? batchArg.slice("--batch=".length).trim() : "";

const run = batchId ? runBatchWorker(batchId) : runVerificationWorker();

run
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[verify-worker] fatal", err);
    process.exit(1);
  });