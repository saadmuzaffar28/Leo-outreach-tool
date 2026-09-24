"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert } from "@/components/ui";
import { Modal } from "@/components/modal";

interface PreviewRow {
  line: number;
  firstName: string;
  lastName: string | null;
  email: string;
  practiceName: string | null;
  errors: { path: string; message: string }[];
  duplicate: boolean;
  duplicateOf: string | null;
  usable: boolean;
}

interface PreviewData {
  rows: PreviewRow[];
  counts: { total: number; valid: number; errors: number; duplicates: number };
  globalErrors: string[];
}

export function LeadImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setPreview(null);
    setFileName(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/leads/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Preview failed");
      setPreview(data);
    } catch (err) {
      setError((err as Error).message);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!preview) return;
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/leads/import/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      close();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const showRows = preview?.rows ?? [];

  return (
    <>
      <Button onClick={() => setOpen(true)}>Import CSV</Button>
      <Modal
        title="Import leads"
        open={open}
        onClose={close}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={!preview || preview.counts.valid === 0 || saving}
            >
              {saving ? "Importing…" : `Import ${preview?.counts.valid ?? 0} valid leads`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block cursor-pointer rounded-lg border-2 border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 hover:border-brand-400 hover:text-brand-600">
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onFile}
              />
              {fileName ?? "Click to choose a CSV file"}
            </label>
            <p className="mt-2 text-xs text-slate-400">
              Expects: <code>Name</code>, <code>Company Name</code>, <code>Email</code>, <code>Phone</code>{" "}
              (also accepts: first_name, last_name, practice_name, custom_field_1/2)
            </p>
          </div>

          {loading ? <p className="text-sm text-slate-500">Validating…</p> : null}
          {error ? <Alert kind="error">{error}</Alert> : null}

          {preview ? (
            <>
              {preview.globalErrors.length > 0 ? (
                <Alert kind="error">
                  {preview.globalErrors.slice(0, 5).join(" · ")}
                </Alert>
              ) : null}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <p className="text-2xl font-bold text-slate-900">{preview.counts.total}</p>
                  <p className="text-xs text-slate-500">Rows</p>
                </div>
                <div className="rounded-lg bg-emerald-50 p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-700">{preview.counts.valid}</p>
                  <p className="text-xs text-emerald-600">Valid</p>
                </div>
                <div className="rounded-lg bg-red-50 p-3 text-center">
                  <p className="text-2xl font-bold text-red-700">
                    {preview.counts.errors + preview.counts.duplicates}
                  </p>
                  <p className="text-xs text-red-600">Errors / duplicates</p>
                </div>
              </div>

              {showRows.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Line</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Email</th>
                        <th className="px-3 py-2">Practice</th>
                        <th className="px-3 py-2">Issues</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {showRows.map((r) => (
                        <tr key={r.line}>
                          <td className="px-3 py-2 text-slate-400">{r.line}</td>
                          <td className="px-3 py-2">{`${r.firstName} ${r.lastName ?? ""}`.trim()}</td>
                          <td className="px-3 py-2">{r.email}</td>
                          <td className="px-3 py-2 text-slate-600">{r.practiceName ?? "—"}</td>
                          <td className="px-3 py-2">
                            {r.duplicate ? (
                              <span className="text-amber-600">Duplicate</span>
                            ) : r.errors.length > 0 ? (
                              <span className="text-red-600">{r.errors.map((e) => e.message).join(", ")}</span>
                            ) : (
                              <span className="text-emerald-600">OK</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );
}