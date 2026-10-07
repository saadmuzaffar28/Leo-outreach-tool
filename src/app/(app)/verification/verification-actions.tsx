"use client";

import { useCallback, useEffect, useState } from "react";

export interface VerificationActionsProps {
  enabled: boolean;
  stats: {
    queued: number;
    processing: number;
    byStatus: Record<string, number>;
    total: number;
  } | null;
}

export function VerificationActions({ enabled, stats }: VerificationActionsProps) {
  // Safe unwrappers
  const queued = stats?.queued ?? 0;
  const processing = stats?.processing ?? 0;
  const byStatus = stats?.byStatus ?? {};
  const total = stats?.total ?? 0;

  const [showClear, setShowClear] = useState(false);

  useEffect(() => {
    if (enabled && queued > 0) {
      setShowClear(true);
    }
  }, [enabled, queued]);

  const handleClearQueued = async () => {
    if (!window.confirm("Clear all queued verification jobs?")) return;
    try {
      const res = await fetch("/api/email-verification/queue/cancel", {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      const cleared = data.cancelled ?? 0;
      if (cleared > 0) {
        window.alert(`Cleared ${cleared} queued verification jobs.`);
      }
    } catch {
      window.alert("Failed to clear queued jobs.");
    }
    setShowClear(false);
  };

  useEffect(() => {
    if (enabled && queued > 0) {
      setShowClear(true);
    }
  }, [enabled, queued]);

  if (!enabled) return null;

  return (
    <div className="mt-4 p-4 border rounded-lg" style={{
      borderColor: queued > 0 ? "brand-600" : "green-500",
      backgroundColor: queued > 0 ? "brand-50" : "green-50",
    }}>
      {showClear && (
        <div className="mb-3 p-3 border border-red-500 bg-red-50 text-red-700 rounded-lg">
          <p>
            <strong>Clear queued:</strong> {queued} pending jobs.
            <button
              onClick={handleClearQueued}
              className="ml-3 rounded-lg border border-red-600 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              Clear
            </button>
          </p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-900">
          {queued} queued ·
          {processing} running
        </span>
      </div>
    </div>
  );
}