"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { verificationStatusStyle, confidenceLabel } from "@/lib/verification/ui";
import { verificationBulkSchema } from "@/lib/validation";
import { normalizeOrNull, parseEmailList } from "@/lib/verification/normalize";

type Stats = {
  total: number;
  byStatus: Record<string, number>;
  fresh: number;
  queued: number;
  processing: number;
  done: number;
  failed: number;
  lastCheckedAt: string | null;
};

type Row = {
  id: string;
  email: string;
  status: string;
  confidence: number;
  checkedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  typoSuggestion: string | null;
};

const PAGE_SIZE = 50;
const STATUS_FILTERS = ["", "VALID", "INVALID", "RISKY", "CATCH_ALL", "UNKNOWN"];

/**
 * Bulk email verification UI (Phase 12/14). Paste addresses or upload a CSV;
 * addresses are queued to the background worker. Results appear in the same
 * table; a live poll refreshes while jobs are still running.
 */
export function VerificationBulk({
  enabled,
  initialStats,
}: {
  enabled: boolean;
  initialStats: Stats | null;
}) {
  const [stats, setStats] = useState<Stats | null>(initialStats);
  const [emails, setEmails] = useState("");
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  // Parsed-but-not-yet-submitted addresses: the upload/validate step creates
  // ZERO batches and ZERO jobs. Only "Verify File" (createBatch) does.
  const [staged, setStaged] = useState<{ filename: string; emails: string[]; source: "file" | "text" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [reloading, setReloading] = useState(false);
  const [reverifyingId, setReverifyingId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  // True while the background queue still has work — drives the live polling.
  const queueBusy = (stats?.queued ?? 0) + (stats?.processing ?? 0) > 0;

  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch("/api/email-verification/stats", { cache: "no-store" });
      if (res.ok) setStats((await res.json()).stats ?? null);
    } catch {
      // keep last known stats
    }
  }, []);

  const refreshList = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((page - 1) * PAGE_SIZE));
    if (statusFilter) params.set("status", statusFilter);
    if (search.trim()) params.set("q", search.trim());
    setReloading(true);
    try {
      const res = await fetch(`/api/email-verification/list?${params}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows ?? []);
        setTotal(data.total ?? 0);
      }
    } catch {
      // transient
    } finally {
      setReloading(false);
    }
  }, [page, statusFilter, search]);

  // Reload everything when filters change.
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Live polling (5s) only while jobs are queued or processing; the interval
  // is torn down automatically when the queue drains.
  useEffect(() => {
    if (!queueBusy) return;
    const timer = setInterval(async () => {
      await refreshStats();
      void refreshList();
    }, 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueBusy, refreshStats, refreshList]);

  /**
   * Validate + dedupe a parsed list and stage it for verification. Creates
   * nothing — no batch, no job, no engine call. `invalid` counts format
   * rejects both from the CSV pre-pass and from a pasted list.
   */
  function stageParsed(raw: string[], csvInvalid: number, csvDuplicates: number, source: "file" | "text", filename: string) {
    const seen = new Set<string>();
    const unique: string[] = [];
    let invalid = csvInvalid;
    let duplicates = csvDuplicates;
    for (const entry of raw) {
      const normalized = normalizeOrNull(entry);
      if (normalized === null) {
        invalid += 1;
      } else if (seen.has(normalized)) {
        duplicates += 1;
      } else {
        seen.add(normalized);
        unique.push(normalized);
      }
    }
    const total = raw.length + csvInvalid + csvDuplicates;
    setBatchId(null);
    if (unique.length === 0) {
      setStaged(null);
      setSubmitMessage(`Found ${total} addresses: 0 valid, ${duplicates} duplicates, ${invalid} invalid format. Nothing to verify.`);
      return;
    }
    setStaged({ filename, emails: unique, source });
    setSubmitMessage(
      `Found ${total} addresses: ${unique.length} valid, ${duplicates} duplicates, ${invalid} invalid format. ` +
        `Nothing queued yet.`,
    );
  }

  /** On upload: parse/validate/dedupe immediately — still zero jobs. */
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const csv = await file.text();
      const parsed = verificationBulkSchema.safeParse({ csv, force });
      if (!parsed.success) {
        setSubmitMessage(parsed.error.issues[0]?.message ?? "Invalid file");
        return;
      }
      const fromCsv = parseEmailList(parsed.data.csv ?? csv);
      stageParsed(fromCsv.emails, fromCsv.invalid, fromCsv.duplicates, "file", file.name);
      setEmails("");
    } catch (err) {
      setSubmitMessage(`Error: ${err instanceof Error ? err.message : "file could not be read"}`);
    } finally {
      setSubmitting(false);
    }
  }

  /** Validate the pasted list (Phase 1 step) — parse only, zero jobs. */
  async function submitBulk() {
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const body = {
        force,
        emails: emails.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
      };
      const parsed = verificationBulkSchema.safeParse(body);
      if (!parsed.success) {
        setSubmitMessage(parsed.error.issues[0]?.message ?? "Invalid request");
        return;
      }
      stageParsed(parsed.data.emails ?? [], 0, 0, "text", "pasted-addresses.txt");
      setEmails("");
    } catch (err) {
      setSubmitMessage(`Error: ${err instanceof Error ? err.message : "request failed"}`);
    } finally {
      setSubmitting(false);
    }
  }

  /** "Verify File" — POST the PARSED addresses (never the raw file). */
  async function createBatch() {
    if (!staged) return;
    setCreating(true);
    setSubmitMessage(null);
    try {
      const res = await fetch("/api/email-verification/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: staged.filename, emails: staged.emails, force }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setSubmitMessage(String(data.error ?? "The batch could not be created"));
        return;
      }
      const skipped = [
        data.invalidFormat ? `${data.invalidFormat} invalid skipped` : null,
        data.duplicates ? `${data.duplicates} duplicates skipped` : null,
      ]
        .filter(Boolean)
        .join(", ");
      setStaged(null);
      setBatchId(String(data.batchId));
      setSubmitMessage(
        `Batch ready: ${data.created} addresses${skipped ? ` (${skipped})` : ""}. ` +
          `Nothing runs until you start it.`,
      );
    } catch (err) {
      setSubmitMessage(`Error: ${err instanceof Error ? err.message : "request failed"}`);
    } finally {
      setCreating(false);
    }
  }

  /** Start the batch we just created — batch-scoped processing only. */
  async function startBatch() {
    if (!batchId) return;
    setStarting(true);
    setSubmitMessage(null);
    try {
      const res = await fetch(`/api/email-verification/batches/${batchId}/start`, { method: "POST" });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setSubmitMessage(String(data.error ?? "Verification could not be started"));
        return;
      }
      setBatchId(null);
      setSubmitMessage(
        data.alreadyRunning ? "Verification is already running." : "Verification started — results appear below.",
      );
      await refreshStats();
      void refreshList();
    } catch (err) {
      setSubmitMessage(`Error: ${err instanceof Error ? err.message : "request failed"}`);
    } finally {
      setStarting(false);
    }
  }

  async function reverify(row: Row) {
    setReverifyingId(row.id);
    try {
      await fetch(`/api/email-verification/${row.id}/reverify`, { method: "POST" });
      await refreshStats();
    } finally {
      setReverifyingId(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const exportHref =
    `/api/email-verification/export` +
    (statusFilter ? `?status=${statusFilter}` : "") +
    (search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "");

  // One button, three steps: validate → verify (creates the batch) → start.
  let primaryLabel = "Validate";
  if (submitting) primaryLabel = "Validating…";
  if (staged) primaryLabel = staged.source === "file" ? "Verify File" : `Verify ${staged.emails.length} addresses`;
  if (creating) primaryLabel = "Creating batch…";

  return (
    <div className="space-y-6">
      {!enabled ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          Email verification is disabled (EMAIL_VERIFICATION_ENABLED=false). Enable it in the environment to use this page.
        </div>
      ) : null}

      {/* Status cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Checked addresses" value={stats?.total ?? 0} accent />
        <StatCard label="Valid" value={stats?.byStatus.VALID ?? 0} />
        <StatCard label="Invalid" value={stats?.byStatus.INVALID ?? 0} />
        <StatCard
          label="Queue"
          value={
            <span className={queueBusy ? "text-brand-600" : ""}>
              {`${stats?.queued ?? 0} queued · ${stats?.processing ?? 0} running`}
            </span>
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Risky" value={stats?.byStatus.RISKY ?? 0} />
        <StatCard label="Catch-all" value={stats?.byStatus.CATCH_ALL ?? 0} />
        <StatCard label="Unknown" value={stats?.byStatus.UNKNOWN ?? 0} />
        <StatCard label="Failed jobs" value={stats?.failed ?? 0} />
      </div>

      {/* Submit */}
      <div className="rounded-xl border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Verify addresses</h2>
        <p className="mt-1 text-xs text-slate-500">
          Upload a CSV or paste addresses — they are parsed, validated and deduped first, and nothing runs until you
          verify and start them. Jobs run in the background, a few at a time, to stay polite to mail servers. Results
          are cached for the configured TTL and shared with the campaign send gate.
        </p>
        <textarea
          value={emails}
          onChange={(e) => {
            setEmails(e.target.value);
            // Typing means the pasted list is the input of record; a staged
            // file parse would otherwise silently win over it.
            if (staged) setStaged(null);
          }}
          rows={5}
          placeholder={"paste@one-per-line.com\nor comma, separated@example.com"}
          className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            <input ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,.xls" className="hidden" onChange={handleFileChange} />
            Upload CSV
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force re-verify (ignore cache)
          </label>
          <button
            type="button"
            onClick={staged ? createBatch : submitBulk}
            disabled={creating || submitting || (!staged && !emails.trim())}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {primaryLabel}
          </button>
          {batchId ? (
            <button
              type="button"
              onClick={startBatch}
              disabled={starting}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start verification"}
            </button>
          ) : null}
          {submitMessage ? <span className="text-sm text-slate-600">{submitMessage}</span> : null}
        </div>
      </div>

      {/* Results */}
      <div className="rounded-xl border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Results</h2>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === "" ? "All statuses" : s}
                </option>
              ))}
            </select>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search address…"
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
          <a
            href={exportHref}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Export CSV
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3">Address</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Confidence</th>
                <th className="px-3 py-3">Checked</th>
                <th className="px-3 py-3">Detail</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const st = verificationStatusStyle(row.status);
                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{row.email}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${st.badge}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-slate-600">{confidenceLabel(row.confidence)}</td>
                    <td className="px-3 py-3 text-slate-500">
                      {new Date(row.checkedAt).toLocaleDateString()} {new Date(row.checkedAt).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">
                      {row.typoSuggestion ? `Typo? → ${row.typoSuggestion}. ` : ""}
                      {row.errorCode ? `${row.errorCode}${row.errorMessage ? `: ${row.errorMessage}` : ""}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        type="button"
                        disabled={reverifyingId === row.id}
                        onClick={() => reverify(row)}
                        className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {reverifyingId === row.id ? "Queuing…" : "Re-verify"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-400">
                    {reloading ? "Loading…" : "No verification results yet. Paste addresses above to get started."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
            <span>
              {Math.min(total, (page - 1) * PAGE_SIZE + 1)}–{Math.min(total, page * PAGE_SIZE)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({ label, value, accent = false }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-brand-500 bg-brand-50" : "border-slate-200"}`}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}