/**
 * Campaign verification gate — pure policy logic (Phase 13).
 *
 * Default policy is OFF: existing campaigns keep their exact previous
 * behaviour. Nothing here ever runs a verification; it only decides, from a
 * STORED result (or its absence), whether a recipient may be sent to.
 *
 * Suppression/ unsubscribe/ hard-bounce rules are NOT represented here and
 * are never overridden: the suppression check always runs first, upstream.
 */

import type { VerificationPolicy, VerificationStatus } from "./types";

/**
 * Which stored statuses a policy refuses to send to.
 *
 *   OFF                        → nothing blocked (verification not required)
 *   WARN                       → nothing blocked; counts are reported only
 *   BLOCK_INVALID              → INVALID
 *   BLOCK_INVALID_AND_RISKY    → INVALID, RISKY, UNKNOWN, CATCH_ALL
 *                                (an unconfirmed mailbox is not mailed to)
 *
 * An address with NO stored verification is never blocked implicitly —
 * blocking the unverified would silently change behaviour for any campaign
 * that turns the policy on before running a bulk verification, and Phase 13
 * forbids silently skipping recipients. The UI shows the unverified count so
 * the operator can decide.
 */
export function blockedStatuses(policy: VerificationPolicy): ReadonlySet<VerificationStatus> {
  switch (policy) {
    case "BLOCK_INVALID":
      return new Set<VerificationStatus>(["INVALID"]);
    case "BLOCK_INVALID_AND_RISKY":
      return new Set<VerificationStatus>(["INVALID", "RISKY", "UNKNOWN", "CATCH_ALL"]);
    case "WARN":
    case "OFF":
    default:
      return new Set<VerificationStatus>();
  }
}

export function isVerificationPolicy(value: unknown): value is VerificationPolicy {
  return typeof value === "string" && (["OFF", "WARN", "BLOCK_INVALID", "BLOCK_INVALID_AND_RISKY"] as string[]).includes(value);
}

/** Defensive: any unknown stored value behaves like OFF (never blocks). */
export function coercePolicy(value: string | null | undefined): VerificationPolicy {
  return isVerificationPolicy(value) ? value : "OFF";
}

export interface GateDecision {
  block: boolean;
  /** Stable skip reason stored on CampaignRecipient.lastError when blocked. */
  reason: string | null;
  /** The status that caused the decision (for logs/counts). */
  status: VerificationStatus | null;
}

export const VERIFICATION_BLOCKED_PREFIX = "verification_blocked";

/**
 * Decide whether `status` (a stored verification result, or null when the
 * address was never verified) is allowed to be sent to under `policy`.
 */
export function decideGate(
  policy: VerificationPolicy,
  status: VerificationStatus | null,
): GateDecision {
  if (policy === "OFF" || policy === "WARN") {
    return { block: false, reason: null, status };
  }
  if (status === null) {
    return { block: false, reason: null, status: null };
  }
  if (blockedStatuses(policy).has(status)) {
    return {
      block: true,
      reason: `${VERIFICATION_BLOCKED_PREFIX}: status=${status}`,
      status,
    };
  }
  return { block: false, reason: null, status };
}

/**
 * Human summary for the campaign UI — explicit about what each policy does,
 * so the operator is never guessing what will be skipped.
 */
export function policyDescription(policy: VerificationPolicy): string {
  switch (policy) {
    case "WARN":
      return "Verification results are shown, but no recipient is skipped.";
    case "BLOCK_INVALID":
      return "Skips recipients whose address is verified INVALID.";
    case "BLOCK_INVALID_AND_RISKY":
      return "Skips recipients verified INVALID, RISKY, UNKNOWN, or CATCH-ALL (only verified deliverable addresses are sent to).";
    case "OFF":
    default:
      return "No verification check before sending (default).";
  }
}
