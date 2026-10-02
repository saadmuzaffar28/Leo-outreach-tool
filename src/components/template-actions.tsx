"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert } from "@/components/ui";
import { Modal } from "@/components/modal";

export function TemplateActions({
  id,
  name,
  isActive,
}: {
  id: string;
  name: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Action failed");
      router.refresh();
      return data;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    await run(`/api/templates/${id}`, "PATCH", { isActive: !isActive });
  }

  async function remove() {
    const res = await run(`/api/templates/${id}`, "DELETE");
    if (res) {
      setConfirmDelete(false);
      router.push("/templates");
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={toggleStatus}
          disabled={busy}
          className="rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          title={isActive ? "Hide from new campaigns" : "Offer this template for new campaigns"}
        >
          {isActive ? "Deactivate" : "Activate"}
        </button>
        <button
          type="button"
          onClick={() => run(`/api/templates/${id}/duplicate`, "POST")}
          disabled={busy}
          className="rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          Duplicate
        </button>
        <Button
          variant="danger"
          onClick={() => {
            setError(null);
            setConfirmDelete(true);
          }}
          disabled={busy}
        >
          Delete
        </Button>
      </div>

      <Modal
        title="Delete template"
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Delete template <span className="font-semibold text-slate-900">&quot;{name}&quot;</span>? Campaigns that already
          started keep their saved copy; finished work is unaffected.
        </p>
      </Modal>
    </div>
  );
}