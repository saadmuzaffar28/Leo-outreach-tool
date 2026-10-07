/**
 * Verification engine client — the clean internal interface:
 *
 *     verifyEmail(email) → EngineOutcome
 *
 * Talks ONLY to the local self-hosted Go service (services/email-verifier,
 * which wraps github.com/AfterShip/email-verifier). No paid API, no external
 * verification vendor. The service is expected to bind loopback only; this
 * client refuses to call anything that is not http(s) on loopback, so a
 * misconfigured EMAIL_VERIFICATION_SERVICE_URL cannot turn this into an
 * SSRF primitive.
 *
 * Failure policy: never throws. A transport/engine failure comes back as
 * `{ ok: false, retryable: true }` so callers can store UNKNOWN and the queue
 * can back off — an engine outage must not fail imports, workers, or sends.
 */

import {
  engineFailureResult,
  normalizeAfterShipResult,
  type AfterShipPayload,
} from "./aftership-adapter";
import type { EngineOutcome, VerificationResult } from "./types";
import { env } from "@/lib/env";

/** Bounded response size — the engine returns a small JSON object. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Loopback-only guard (SSRF defence). The verifier must operate on email
 * addresses only; its HTTP client may never be pointed at an arbitrary host.
 */
export function isLoopbackServiceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

function serviceBaseUrl(): string | null {
  const base = env.EMAIL_VERIFICATION_SERVICE_URL.replace(/\/+$/, "");
  return isLoopbackServiceUrl(base) ? base : null;
}

/** Classifies fetch/HTTP failures into stable error codes. */
function transportFailure(err: unknown): { errorCode: string; errorMessage: string } {
  if (err instanceof Error && err.name === "AbortError") {
    return { errorCode: "engine_timeout", errorMessage: "Verification engine did not answer in time" };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|connect ECONNREFUSED|network/i.test(message)) {
    return { errorCode: "service_unavailable", errorMessage: "Verification engine is unavailable" };
  }
  return { errorCode: "engine_error", errorMessage: message };
}

/**
 * Ask the engine to verify one address.
 *
 * `EMAIL_VERIFICATION_TIMEOUT_MS` bounds the whole request. The Go service
 * additionally bounds DNS/SMTP operations with its own connect/operation
 * timeouts, so a hung remote mail server cannot outlive this call for long.
 */
export async function verifyEmail(email: string): Promise<EngineOutcome> {
  const base = serviceBaseUrl();
  if (!base) {
    return {
      ok: false,
      errorCode: "service_misconfigured",
      errorMessage:
        "EMAIL_VERIFICATION_SERVICE_URL must be an http(s) loopback address",
      retryable: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.EMAIL_VERIFICATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.EMAIL_VERIFICATION_SERVICE_TOKEN
          ? { authorization: `Bearer ${env.EMAIL_VERIFICATION_SERVICE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ email }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 4xx from the engine = the request itself was rejected (bad input or
      // bad token) — retrying identical input cannot help.
      const retryable = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        errorCode: `engine_http_${res.status}`,
        errorMessage: `Verification engine responded ${res.status}`,
        retryable,
      };
    }

    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return { ok: false, errorCode: "engine_bad_response", errorMessage: "Engine response too large", retryable: false };
    }

    let payload: AfterShipPayload;
    try {
      payload = JSON.parse(text) as AfterShipPayload;
    } catch {
      return { ok: false, errorCode: "engine_bad_response", errorMessage: "Engine returned invalid JSON", retryable: true };
    }

    if (!payload || typeof payload !== "object" || !payload.syntax) {
      return { ok: false, errorCode: "engine_bad_response", errorMessage: "Engine response missing syntax block", retryable: true };
    }

    return { ok: true, raw: payload };
  } catch (err) {
    const { errorCode, errorMessage } = transportFailure(err);
    return { ok: false, errorCode, errorMessage, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * verifyEmail + normalization in one call: the form the worker/API use.
 * On engine failure an UNKNOWN result is produced — never INVALID.
 */
export async function verifyAndNormalize(email: string): Promise<
  { ok: true; result: VerificationResult } | { ok: false; errorCode: string; errorMessage: string; retryable: boolean }
> {
  const outcome = await verifyEmail(email);
  if (!outcome.ok) return outcome;
  return { ok: true, result: normalizeAfterShipResult(email, outcome.raw as AfterShipPayload) };
}

/** Liveness probe for the sidecar (used by ops tooling / diagnostics). */
export async function engineHealth(): Promise<{ ok: boolean; detail: string }> {
  const base = serviceBaseUrl();
  if (!base) return { ok: false, detail: "service URL not configured for loopback" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${base}/healthz`, { signal: controller.signal });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Re-exported for callers that only need "failure ⇒ UNKNOWN result". */
export { engineFailureResult };
