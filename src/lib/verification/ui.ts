/**
 * UI presentation helpers for verification statuses (server-safe, no hooks).
 * Kept out of components so badge colours/words live in exactly one place.
 */

export const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  VALID: "Valid — likely deliverable",
  INVALID: "Invalid — address cannot receive mail",
  CATCH_ALL: "Catch-all — mailbox existence unconfirmed",
  RISKY: "Risky — deliverable but with a warning",
  UNKNOWN: "Unknown — could not be confirmed",
};

const BADGE_STYLES: Record<string, string> = {
  VALID: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  INVALID: "bg-red-50 text-red-700 ring-red-200",
  CATCH_ALL: "bg-amber-50 text-amber-700 ring-amber-200",
  RISKY: "bg-orange-50 text-orange-700 ring-orange-200",
  UNKNOWN: "bg-slate-100 text-slate-600 ring-slate-200",
};

const DOT_STYLES: Record<string, string> = {
  VALID: "bg-emerald-500",
  INVALID: "bg-red-500",
  CATCH_ALL: "bg-amber-500",
  RISKY: "bg-orange-500",
  UNKNOWN: "bg-slate-400",
};

export function verificationStatusStyle(status: string | null | undefined): {
  badge: string;
  dot: string;
  label: string;
} {
  const key = status ?? "";
  return {
    badge: BADGE_STYLES[key] ?? "bg-slate-100 text-slate-600 ring-slate-200",
    dot: DOT_STYLES[key] ?? "bg-slate-400",
    label: VERIFICATION_STATUS_LABELS[key] ?? "Not verified",
  };
}

/** Short human confidence label for a score. */
export function confidenceLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return "—";
  return `${score}/100`;
}