"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert, Label, TextInput, Select } from "@/components/ui";
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

interface GroupOption {
  id: string;
  name: string;
  contactCount: number;
}

interface ImportResult {
  total: number;
  imported: number;
  duplicates: number;
  invalid: number;
  skipped: number;
  addedToGroup: number;
  group: { id: string; name: string } | null;
  message: string;
}

export function LeadImport({ groups = [] }: { groups?: GroupOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // Group destination: "new" | "existing" | "none"
  const [mode, setMode] = useState<"none" | "new" | "existing">("none");
  const [groupName, setGroupName] = useState("");
  const [existingGroupId, setExistingGroupId] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  function close() {
    setOpen(false);
    setPreview(null);
    setFileName(null);
    setError(null);
    setMode("none");
    setGroupName("");
    setExistingGroupId("");
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setLoading(true);
    setError(null);
    setResult(null);
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
      // Default to creating a group, since that is the common case.
      setMode("new");
      setGroupName(file.name.replace(/\.csv$/i, "").slice(0, 120));
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
    if (mode === "new" && groupName.trim().length === 0) {
      setError("Enter a group name, or choose to import without a group.");
      return;
    }
    if (mode === "existing" && !existingGroupId) {
      setError("Choose which group to add these contacts to.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/leads/import/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv: text,
          ...(mode === "new" ? { groupName: groupName.trim() } : {}),
          ...(mode === "existing" ? { groupId: existingGroupId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setResult(data as ImportResult);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const showRows = preview?.rows ?? [];
  const selectedGroupName =
    mode === "new"
      ? groupName.trim()
      : mode === "existing"
        ? groups.find((g) => g.id === existingGroupId)?.name ?? ""
        : null;

  if (result) {
    return (
      <>
        <Button onClick={() => setOpen(true)}>Import CSV</Button>
        <Modal
          title="Import complete"
          open={open}
          onClose={close}
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
              {result.group ? (
                <Button
                  onClick={() => {
                    const id = result.group!.id;
                    close();
                    router.push(`/leads?tab=email&group=${encodeURIComponent(id)}`);
                  }}
                >
                  View Group
                </Button>
              ) : null}
            </>
          }
        >
          <div className="space-y-4">
            {result.group ? (
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Group</p>
                <p className="text-sm font-semibold text-slate-900">{result.group.name}</p>
              </div>
            ) : (
              <Alert kind="info">
                Imported without a group — these contacts are in All Contacts only.
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-emerald-50 p-3 text-center">
                <p className="text-2xl font-bold text-emerald-700">{result.imported}</p>
                <p className="text-xs text-emerald-600">Imported</p>
              </div>
              <div className="rounded-lg bg-amber-50 p-3 text-center">
                <p className="text-2xl font-bold text-amber-700">{result.duplicates}</p>
                <p className="text-xs text-amber-600">Duplicates</p>
              </div>
              <div className="rounded-lg bg-red-50 p-3 text-center">
                <p className="text-2xl font-bold text-red-700">{result.invalid}</p>
                <p className="text-xs text-red-600">Invalid</p>
              </div>
              <div className="rounded-lg bg-slate-100 p-3 text-center">
                <p className="text-2xl font-bold text-slate-700">{result.skipped}</p>
                <p className="text-xs text-slate-500">Skipped</p>
              </div>
            </div>

            {result.duplicates > 0 ? (
              <Alert kind="info">
                {result.duplicates} contact{result.duplicates === 1 ? "" : "s"} already existed and
                were added to the group instead of being duplicated.
              </Alert>
            ) : null}
          </div>
        </Modal>
      </>
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Import CSV</Button>
      <Modal
        title="Import Contacts"
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
            <p className="mb-1.5 text-sm font-medium text-slate-700">CSV File</p>
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
              Email is required; every other column is optional. Recognized: <code>Name</code>,{" "}
              <code>Company Name</code>, <code>Email</code>, <code>Phone</code> (also first_name,
              last_name, practice_name, custom_field_1/2)
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

              {/* -------------------------------------------- group step */}
              <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                <p className="text-sm font-semibold text-slate-800">Create or select a group</p>

                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="group-mode"
                    className="mt-1"
                    checked={mode === "new"}
                    onChange={() => setMode("new")}
                  />
                  <span>
                    <span className="font-medium">Create a new group</span>
                    <span className="block text-xs text-slate-500">
                      Imported contacts will be placed in this group.
                    </span>
                  </span>
                </label>

                {mode === "new" ? (
                  <div>
                    <Label htmlFor="import-group-name">Group Name</Label>
                    <TextInput
                      id="import-group-name"
                      value={groupName}
                      onChange={(e) => setGroupName(e.target.value)}
                      placeholder="Healthcare Prospects"
                      maxLength={120}
                    />
                  </div>
                ) : null}

                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="group-mode"
                    className="mt-1"
                    checked={mode === "existing"}
                    onChange={() => setMode("existing")}
                    disabled={groups.length === 0}
                  />
                  <span>
                    <span className="font-medium">
                      Add contacts to an existing group
                    </span>
                    {groups.length === 0 ? (
                      <span className="block text-xs text-slate-500">
                        You have no groups yet.
                      </span>
                    ) : (
                      <span className="block text-xs text-slate-500">
                        Contacts that already exist are linked, not duplicated.
                      </span>
                    )}
                  </span>
                </label>

                {mode === "existing" ? (
                  <div>
                    <Label htmlFor="import-existing-group">Existing group</Label>
                    <Select
                      id="import-existing-group"
                      value={existingGroupId}
                      onChange={(e) => setExistingGroupId(e.target.value)}
                    >
                      <option value="">Select group…</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.contactCount})
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : null}

                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="group-mode"
                    className="mt-1"
                    checked={mode === "none"}
                    onChange={() => setMode("none")}
                  />
                  <span>
                    <span className="font-medium">No group</span>
                    <span className="block text-xs text-slate-500">
                      Import into All Contacts only.
                    </span>
                  </span>
                </label>
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
                              <span className="text-red-600">
                                {r.errors.map((e) => e.message).join(", ")}
                              </span>
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
