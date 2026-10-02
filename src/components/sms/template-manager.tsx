"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { Button, Label, TextInput } from "@/components/ui";
import { useToast } from "@/components/sms/toast";

interface SmsTemplate {
  id: string;
  name: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_FORM = { id: "", name: "", message: "" };

export function SmsTemplateManager() {
  const toast = useToast();
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SmsTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sms/templates");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { templates: SmsTemplate[] };
      setTemplates(data.templates);
    } catch {
      toast.push("Failed to load templates", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const isEdit = Boolean(form.id);
      const res = await fetch(isEdit ? `/api/sms/templates/${form.id}` : "/api/sms/templates", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEdit ? { name: form.name, message: form.message } : { name: form.name, message: form.message }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      toast.push(isEdit ? "Template updated" : "Template created", "success");
      setModalOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/sms/templates/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.push("Template deleted", "success");
      setDeleteTarget(null);
      load();
    } catch {
      toast.push("Delete failed", "error");
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          Reusable SMS messages. Use variables like <code className="rounded bg-slate-100 px-1">{"{{name}}"}</code> to
          personalize each message.
        </p>
        <Button onClick={() => { setForm(EMPTY_FORM); setModalOpen(true); }}>New SMS template</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {loading ? (
          <div className="md:col-span-2 rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400 shadow-sm">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="md:col-span-2 rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400 shadow-sm">
            No SMS templates yet. Create one to reuse it in campaigns.
          </div>
        ) : (
          templates.map((t) => (
            <div key={t.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold text-slate-900">{t.name}</h3>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-600">{t.message}</p>
                  <p className="mt-2 text-xs text-slate-400">
                    {t.message.length} chars · updated {new Date(t.updatedAt).toLocaleDateString()}
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button
                      className="text-sm font-medium text-brand-600 hover:underline"
                      onClick={() => { setForm({ id: t.id, name: t.name, message: t.message }); setModalOpen(true); }}
                    >
                      Edit
                    </button>
                    <a href="/sms/campaigns/new" className="text-sm font-medium text-brand-600 hover:underline">
                      Use in campaign
                    </a>
                  </div>
                </div>
                <button
                  className="shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50"
                  onClick={() => setDeleteTarget(t)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add/Edit modal */}
      <Modal
        title={form.id ? "Edit SMS template" : "New SMS template"}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !form.name.trim() || !form.message.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="st-name">Name</Label>
            <TextInput id="st-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="st-message">Message</Label>
            <textarea
              id="st-message"
              rows={5}
              maxLength={1600}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder={"Hi {{name}}, this is Leo's outreach…"}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-400">{form.message.length}/1600 characters</p>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        title="Delete template?"
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Delete</Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Delete <strong>{deleteTarget?.name}</strong>? Campaigns already sent are unaffected. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
