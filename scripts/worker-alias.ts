/**
 * Compile-time "@/" → runtime resolver for the plain-node standalone workers.
 *
 * tsc keeps tsconfig `paths` specifiers verbatim in emitted JS, and every
 * worker lib (src/lib/worker, src/lib/warmup/*, src/lib/verification/*)
 * imports via "@/lib/...". tsx resolves those in dev; a compiled PM2 worker
 * runs on plain node and must map "@/" onto its own compiled tree
 * (dist/workers/src, produced by tsconfig.workers.json) at runtime.
 *
 * Import this module FIRST in every scripts/*-worker.ts entrypoint, and only
 * engage the hook under NODE_ENV=production (the PM2 workers) so the tsx dev
 * path — which resolves "@/" natively — is never perturbed.
 */
import Module from "node:module";
import path from "node:path";

if (process.env.NODE_ENV === "production") {
  // dist/workers/scripts/worker-alias.js → dist/workers/src
  const compiledRoot = path.join(__dirname, "..", "src");
  const resolver = Module as unknown as {
    _resolveFilename(this: unknown, request: string, ...rest: unknown[]): string;
  };
  const originalResolveFilename = resolver._resolveFilename;
  resolver._resolveFilename = function (this: unknown, request: string, ...args: unknown[]) {
    if (request.startsWith("@/")) {
      request = path.join(compiledRoot, request.slice(2));
    }
    return originalResolveFilename.call(this, request, ...args);
  };
}