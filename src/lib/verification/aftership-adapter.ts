/**
 * The AfterShip adapter — the ONLY module allowed to know the payload shapes
 * of github.com/AfterShip/email-verifier (served by the local Go verification
 * service, `services/email-verifier`).
 *
 * Responsibilities:
 *   1. Describe the engine's JSON contract (types below).
 *   2. Map raw engine facts + engine errors onto Leo Outreach's normalized
 *      {@link VerificationResult} statuses (Phase 4/5 semantics).
 *   3. Keep SMTP safety rules: a temporary/ambiguous response is NEVER
 *      classified INVALID (4xx, timeout, greylisting, blocked port 25,
 *      anti-enumeration ⇒ UNKNOWN; clear mailbox rejection ⇒ INVALID;
 *      acceptance ⇒ VALID; catch-all ⇒ CATCH_ALL).
 *
 * Nothing outside this file imports the `AfterShip*` types below.
 */

import { redactText } from "@/lib/redact";
import { computeConfidence } from "./scoring";
import {
  isPlausibleEmail,
  normalizeEmail,
} from "./normalize";
import {
  VERIFICATION_PROVIDER,
  VERIFICATION_VERSION,
  type VerificationResult,
  type VerificationStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Engine wire contract (produced by services/email-verifier)
// ---------------------------------------------------------------------------

/**
 * Classified SMTP/DNS failure kinds. The Go service derives these from
 * AfterShip's *LookupError kinds and SMTP reply codes (4xx/5xx) so callers
 * never parse provider prose.
 */
export type AfterShipErrorKind =
  | "no_such_host" // NXDOMAIN — the domain does not exist
  | "no_mx" // domain exists but has no usable MX record
  | "mailbox_rejected" // definitive 5xx rejection of the recipient
  | "timeout" // connection/operation timeout (incl. blocked port 25 hangs)
  | "connection_refused" // TCP refused / no route to mail server
  | "blocked" // we (the sender) are blocked — RBL/policy, not about the address
  | "temp_failure" // SMTP 4xx / greylisting / try-again-later
  | "service_unavailable" // 421-style service-level refusal
  | "other"; // unclassified — always treated as ambiguous

export interface AfterShipError {
  message: string;
  details: string;
  kind: AfterShipErrorKind;
}

export interface AfterShipSmtp {
  host_exists: boolean;
  full_inbox: boolean;
  catch_all: boolean;
  deliverable: boolean;
  disabled: boolean;
}

/** Exact JSON body POSTed back by the local verification service. */
export interface AfterShipPayload {
  email: string;
  reachable: "yes" | "no" | "unknown";
  syntax: { username: string; domain: string; valid: boolean };
  has_mx_records: boolean;
  disposable: boolean;
  role_account: boolean;
  free: boolean;
  suggestion: string;
  smtp: AfterShipSmtp | null;
  error: AfterShipError | null;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Bound on stored error prose; SMTP replies can be multi-line essays. */
const MAX_ERROR_DETAIL = 300;

interface Verdict {
  status: VerificationStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Map a completed engine payload to a status.
 *
 * Order matters and encodes Phase 5's SMTP-safety rules:
 *   syntax  → INVALID      (definitive, no network needed)
 *   diehard → RISKY        (disposable — can receive, but a warning)
 *   engine error → per-kind (only no_such_host / no_mx / mailbox_rejected
 *                            are definitive; everything else ⇒ UNKNOWN)
 *   DNS facts → INVALID when MX definitively missing
 *   SMTP facts → deliverable⇒VALID, full/disabled⇒RISKY,
 *                catch-all⇒CATCH_ALL, refused⇒INVALID,
 *                inconclusive⇒UNKNOWN (anti-enumeration etc.)
 *   role account upgrades a VALID verdict to RISKY (significant warning).
 */
function classifyPayload(payload: AfterShipPayload): Verdict {
  const { syntax, smtp, error } = payload;

  if (!syntax.valid) {
    return { status: "INVALID", errorCode: "syntax_invalid", errorMessage: "Email address syntax is invalid" };
  }

  // Disposable domains resolve and often accept mail — deliverable-ish, but a
  // significant warning, never a clean VALID.
  if (payload.disposable) {
    return { status: "RISKY", errorCode: "disposable_domain", errorMessage: "Disposable email provider" };
  }

  if (error) {
    const detail = redactText(error.details || error.message, MAX_ERROR_DETAIL);
    switch (error.kind) {
      case "no_such_host":
        return { status: "INVALID", errorCode: "domain_not_found", errorMessage: detail };
      case "no_mx":
        return { status: "INVALID", errorCode: "no_mx_record", errorMessage: detail };
      case "mailbox_rejected":
        // Definitive 5xx "user unknown"-class rejection of this recipient.
        return { status: "INVALID", errorCode: "smtp_mailbox_rejected", errorMessage: detail };
      case "timeout":
        return { status: "UNKNOWN", errorCode: "smtp_timeout", errorMessage: detail };
      case "connection_refused":
        return { status: "UNKNOWN", errorCode: "smtp_connection_refused", errorMessage: detail };
      case "blocked":
        // The server refused US (RBL/policy) — says nothing about the mailbox.
        return { status: "UNKNOWN", errorCode: "smtp_blocked", errorMessage: detail };
      case "temp_failure":
        return { status: "UNKNOWN", errorCode: "smtp_temporary_failure", errorMessage: detail };
      case "service_unavailable":
        return { status: "UNKNOWN", errorCode: "smtp_service_unavailable", errorMessage: detail };
      default:
        return { status: "UNKNOWN", errorCode: "smtp_error", errorMessage: detail };
    }
  }

  if (!payload.has_mx_records) {
    return {
      status: "INVALID",
      errorCode: "no_mx_record",
      errorMessage: payload.suggestion
        ? `Domain has no MX record. Did you mean ${payload.suggestion}?`
        : "Domain has no MX record",
    };
  }

  if (smtp) {
    // SMTP accepted RCPT for this exact mailbox. Definitive (given the
    // exchange completed without error).
    if (smtp.deliverable) {
      if (payload.role_account) {
        return { status: "RISKY", errorCode: "role_account", errorMessage: "Role-based address (e.g. info@)" };
      }
      return { status: "VALID", errorCode: null, errorMessage: null };
    }
    // Mailbox exists but reported full — deliverability is compromised but
    // the address is real.
    if (smtp.full_inbox) {
      return { status: "RISKY", errorCode: "mailbox_full", errorMessage: "Mailbox reported full" };
    }
    // Provider refused mailbox access for policy reasons ("554 not allowed").
    if (smtp.disabled) {
      return { status: "RISKY", errorCode: "mailbox_disabled", errorMessage: "Mailbox disabled or blocked by policy" };
    }
    // The catch-all probe was accepted: mailbox existence cannot be confirmed.
    if (smtp.catch_all) {
      return {
        status: "CATCH_ALL",
        errorCode: "catch_all_domain",
        errorMessage: "Mail server accepts unknown recipients (catch-all)",
      };
    }
    // Catch-all ruled out AND our probe was refused ⇒ strong negative.
    if (payload.reachable === "no") {
      return { status: "INVALID", errorCode: "smtp_mailbox_rejected", errorMessage: "Mail server rejected the mailbox" };
    }
    // Server answered but would not confirm (anti-enumeration etc.).
    return {
      status: "UNKNOWN",
      errorCode: "smtp_inconclusive",
      errorMessage: "Mail server did not confirm mailbox existence",
    };
  }

  // SMTP checks disabled/unavailable (e.g. outbound port 25 blocked) — DNS
  // evidence alone can never prove a mailbox exists.
  return {
    status: "UNKNOWN",
    errorCode: "smtp_not_checked",
    errorMessage: "DNS checks passed; SMTP mailbox check was not performed",
  };
}

/**
 * Normalize a completed engine payload into Leo Outreach's result model.
 */
export function normalizeAfterShipResult(email: string, payload: AfterShipPayload): VerificationResult {
  const normalizedEmail = normalizeEmail(email);
  const verdict = classifyPayload(payload);

  const syntaxValid = payload.syntax.valid;
  const dnsDefinitiveFailure =
    payload.error?.kind === "no_such_host" || payload.error?.kind === "no_mx";
  const domainValid = syntaxValid && !dnsDefinitiveFailure;
  const mxValid = domainValid && payload.has_mx_records;
  const smtpChecked = payload.smtp !== null;
  const smtpReachable = payload.smtp?.deliverable === true;

  return {
    email,
    normalizedEmail,
    status: verdict.status,
    confidence: computeConfidence({
      status: verdict.status,
      syntaxValid,
      domainValid,
      mxValid,
      smtpChecked,
      smtpReachable,
      catchAll: payload.smtp?.catch_all === true && verdict.status === "CATCH_ALL",
      disposable: payload.disposable,
      roleAccount: payload.role_account,
    }),
    syntaxValid,
    domainValid,
    mxValid,
    smtpReachable,
    catchAll: verdict.status === "CATCH_ALL",
    disposable: payload.disposable,
    roleAccount: payload.role_account,
    freeProvider: payload.free,
    typoSuggestion: payload.suggestion || null,
    provider: VERIFICATION_PROVIDER,
    errorCode: verdict.errorCode,
    errorMessage: verdict.errorMessage,
    checkedAt: new Date(),
    verificationVersion: VERIFICATION_VERSION,
  };
}

/**
 * Definitive local verdict for an address that fails format validation —
 * no network involved, always INVALID / syntax_invalid.
 */
export function syntaxFailureResult(email: string): VerificationResult {
  return {
    email,
    normalizedEmail: normalizeEmail(email),
    status: "INVALID",
    confidence: computeConfidence({
      status: "INVALID",
      syntaxValid: false,
      domainValid: false,
      mxValid: false,
      smtpChecked: false,
      smtpReachable: false,
      catchAll: false,
      disposable: false,
      roleAccount: false,
    }),
    syntaxValid: false,
    domainValid: false,
    mxValid: false,
    smtpReachable: false,
    catchAll: false,
    disposable: false,
    roleAccount: false,
    freeProvider: false,
    typoSuggestion: null,
    provider: VERIFICATION_PROVIDER,
    errorCode: "syntax_invalid",
    errorMessage: "Email address syntax is invalid",
    checkedAt: new Date(),
    verificationVersion: VERIFICATION_VERSION,
  };
}

/**
 * Normalize an ENGINE/TRANSPORT failure (service down, request timeout,
 * malformed response) into a result. Always UNKNOWN — a failure to verify is
 * never evidence against the address.
 */
export function engineFailureResult(email: string, errorCode: string, errorMessage: string): VerificationResult {
  const normalizedEmail = normalizeEmail(email);
  const syntaxValid = isPlausibleEmail(normalizedEmail);
  return {
    email,
    normalizedEmail,
    status: "UNKNOWN",
    confidence: computeConfidence({
      status: "UNKNOWN",
      syntaxValid,
      domainValid: false,
      mxValid: false,
      smtpChecked: false,
      smtpReachable: false,
      catchAll: false,
      disposable: false,
      roleAccount: false,
    }),
    syntaxValid,
    domainValid: false,
    mxValid: false,
    smtpReachable: false,
    catchAll: false,
    disposable: false,
    roleAccount: false,
    freeProvider: false,
    typoSuggestion: null,
    provider: VERIFICATION_PROVIDER,
    errorCode,
    errorMessage: redactText(errorMessage, MAX_ERROR_DETAIL),
    checkedAt: new Date(),
    verificationVersion: VERIFICATION_VERSION,
  };
}
