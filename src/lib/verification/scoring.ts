/**
 * Deterministic heuristic confidence scoring for email verification.
 *
 * ISOLATED ON PURPOSE (Phase 6): scoring can be retuned here without touching
 * the verification engine, the adapter, the worker, or the database schema.
 *
 * What this number is:
 *   A deterministic 0–100 heuristic describing how much evidence backs the
 *   verdict — roughly "how confident are we that this address is deliverable".
 *
 * What this number is NOT:
 *   - Not a machine-learning probability.
 *   - Not a guarantee of delivery or inbox placement.
 *
 * Principles encoded below (see the per-factor comments):
 *   High confidence: syntax valid, domain exists, MX exists, SMTP accepted
 *     the exact mailbox, not catch-all, not disposable.
 *   Low confidence:  catch-all, SMTP unavailable/blocked, greylisting,
 *     temporary responses.
 *   Very low:        nonexistent domain, no MX, clear SMTP mailbox rejection.
 */

import type { VerificationStatus } from "./types";

export interface ConfidenceInput {
  status: VerificationStatus;
  syntaxValid: boolean;
  domainValid: boolean;
  mxValid: boolean;
  /** An SMTP exchange with the mail server actually happened. */
  smtpChecked: boolean;
  /** SMTP accepted RCPT for this exact mailbox. */
  smtpReachable: boolean;
  catchAll: boolean;
  disposable: boolean;
  roleAccount: boolean;
}

/**
 * Hard ceilings per status. The caps are what keep the score honest: no
 * amount of DNS evidence can push a CATCH_ALL above 60, and an INVALID
 * verdict can never score above 15 no other factor says.
 */
const STATUS_CAPS: Record<VerificationStatus, number> = {
  VALID: 100,
  RISKY: 55,
  CATCH_ALL: 60,
  UNKNOWN: 45,
  INVALID: 15,
};

/**
 * Additive factors. Each is evidence that was actually observed — the score
 * only counts facts, never assumptions.
 */
const POINTS = {
  syntaxValid: 25,
  domainResolves: 10,
  mxExists: 15,
  smtpExchangeHappened: 10,
  smtpAcceptedMailbox: 30,
  notCatchAll: 5,
  notDisposable: 5,
  roleAccountPenalty: -10,
} as const;

/** Compute the 0–100 heuristic confidence. Pure and deterministic. */
export function computeConfidence(input: ConfidenceInput): number {
  let score = 0;

  if (input.syntaxValid) score += POINTS.syntaxValid;
  if (input.domainValid) score += POINTS.domainResolves;
  if (input.mxValid) score += POINTS.mxExists;
  if (input.smtpChecked) score += POINTS.smtpExchangeHappened;
  if (input.smtpReachable) score += POINTS.smtpAcceptedMailbox;
  if (!input.catchAll) score += POINTS.notCatchAll;
  if (!input.disposable) score += POINTS.notDisposable;
  if (input.roleAccount) score += POINTS.roleAccountPenalty;

  const cap = STATUS_CAPS[input.status];
  return Math.max(0, Math.min(cap, score));
}
