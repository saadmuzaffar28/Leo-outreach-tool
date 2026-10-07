#!/usr/bin/env node
/**
 * Build (and optionally run) the self-hosted email verification service.
 *
 *   node scripts/verifier.mjs build   → dist/verifier/email-verifier(.exe)
 *   node scripts/verifier.mjs start   → build, then run it in the foreground
 *
 * Requires a Go toolchain >= 1.25 on PATH (or GO_BIN pointing at one).
 * The service is consumed as a Go MODULE dependency — no vendored sources.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = path.join(root, "services", "email-verifier");
const outDir = path.join(root, "dist", "verifier");
const binName = process.platform === "win32" ? "email-verifier.exe" : "email-verifier";
const binPath = path.join(outDir, binName);
const goBin = process.env.GO_BIN || "go";

function build() {
  if (!existsSync(path.join(serviceDir, "go.mod"))) {
    console.error(`[verifier] missing go.mod in ${serviceDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  console.log(`[verifier] building → ${binPath}`);
  try {
    execFileSync(goBin, ["build", "-o", binPath, "."], {
      cwd: serviceDir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error(
      "[verifier] Go build failed. A Go toolchain >= 1.25 is required " +
        "(https://go.dev/dl/), or set GO_BIN to your go executable.",
    );
    process.exit(err?.status ?? 1);
  }
  console.log("[verifier] build ok");
}

function start() {
  if (!existsSync(binPath)) build();
  console.log(`[verifier] starting ${binPath}`);
  const child = spawn(binPath, [], { cwd: root, stdio: "inherit" });
  const forward = (sig) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

const cmd = process.argv[2] ?? "build";
if (cmd === "build") build();
else if (cmd === "start") start();
else {
  console.error(`unknown command: ${cmd} (expected "build" or "start")`);
  process.exit(1);
}
