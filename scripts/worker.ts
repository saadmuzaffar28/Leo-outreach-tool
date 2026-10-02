import "dotenv/config";
import { runWorker } from "../src/lib/worker";

runWorker()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[worker] fatal", err);
    process.exit(1);
  });