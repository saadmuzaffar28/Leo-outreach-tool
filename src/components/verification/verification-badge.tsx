"use client";

import { useCallback, useState } from "react";
import { verificationStatusStyle, confidenceLabel } from "@/lib/verification/ui";

/**
 * One-cell verification control for a lead row. Server renders the stored
 * result (if any); clicking calls the single-address verification endpoint,
 * runs synchronously (with cache), and updates the cell in place.
 *
 * Intentionally tiny: no polling, no modal — recheck lives on the
 * /verification bulk page and in individual re-verify actions.
 */
export function VerificationBadge({
  email,
  initialStatus,
  initialConfidence,
}: {
  email: string;
  initialStatus?: string | null;
  initialConfidence?: number | null;
}) {
  const [status, setStatus] = useState<string | null>(initialStatus ?? null);
  const [confidence, setConfidence] = useState<number | null>(initialConfidence ?? null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const style = verificationStatusStyle(status);

  const verify = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/email-verification/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setStatus(data.verification?.status ?? null);
      setConfidence(data.verification?.confidence ?? null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, email]);

  if (!status) {
    return (
      <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-slate-500">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">Unverified</span>
        <button
          type="button"
          onClick={verify}
          disabled={busy}
          className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Verify"}
        </button>
        {failed ? <span className="text-red-500" title="Verification engine unavailable">⚠</span> : null}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${style.badge}`}
        title={`${style.label}. Confidence ${confidenceLabel(confidence)}.`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        {status}
      </span>
      <span className="text-xs text-slate-400">{confidenceLabel(confidence)}</span>
    </span>
  );
}