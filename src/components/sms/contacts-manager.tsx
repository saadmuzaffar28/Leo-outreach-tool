"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { Button, Label, TextInput } from "@/components/ui";
import { useToast } from "@/components/sms/toast";

interface Contact {
  id: string;
  name: string;
  phoneNumber: string;
  optOut: boolean;
  status: string;
  createdAt: string;
  _count?: { messages: number };
}

const EMPTY_FORM = { id: "", name: "", phoneNumber: "" };

export function ContactsManager() {
  const toast = useToast();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllConfirmText, setDeleteAllConfirmText] = useState("");
  const [deletingAll, setDeletingAll] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (p: number, q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sms/contacts?page=${p}&pageSize=25&search=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { contacts: Contact[]; total: number; page: number; pageSize: number };
      setContacts(data.contacts);
      setTotal(data.total);
      setPage(data.page);
      setPages(Math.max(1, Math.ceil(data.total / data.pageSize)));
    } catch {
      toast.push("Failed to load contacts", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(1, "");
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const isEdit = Boolean(form.id);
      const res = await fetch(isEdit ? `/api/sms/contacts/${form.id}` : "/api/sms/contacts", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? { name: form.name, phoneNumber: form.phoneNumber }
            : { name: form.name, phoneNumber: form.phoneNumber },
        ),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      toast.push(isEdit ? "Contact updated" : "Contact added", "success");
      setModalOpen(false);
      setForm(EMPTY_FORM);
      load(page, search);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleOptOut(c: Contact) {
    try {
      const res = await fetch(`/api/sms/contacts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optOut: !c.optOut }),
      });
      if (!res.ok) throw new Error();
      toast.push(c.optOut ? "Contact opted back in" : "Contact marked as opted out", "success");
      load(page, search);
    } catch {
      toast.push("Update failed", "error");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/sms/contacts/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.push("Contact deleted", "success");
      setDeleteTarget(null);
      load(page, search);
    } catch {
      toast.push("Delete failed", "error");
    }
  }

  async function confirmDeleteAll() {
    setDeletingAll(true);
    try {
      const res = await fetch("/api/sms/contacts?confirm=all", { method: "DELETE" });
      const data = (await res.json()) as { error?: string; deleted?: number };
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      toast.push(`Deleted ${data.deleted ?? 0} contacts`, "success");
      setDeleteAllOpen(false);
      setDeleteAllConfirmText("");
      load(1, "");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setDeletingAll(false);
    }
  }

  async function runImport() {
    setSaving(true);
    try {
      const res = await fetch("/api/sms/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = (await res.json()) as { error?: string; imported?: number; updated?: number; failed?: number };
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      toast.push(`Imported ${data.imported ?? 0}, updated ${data.updated ?? 0}, failed ${data.failed ?? 0}`, "success");
      setImportOpen(false);
      setCsvText("");
      load(1, search);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Import failed", "error");
    } finally {
      setSaving(false);
    }
  }

  function onFilePicked(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            load(1, search);
          }}
        >
          <TextInput placeholder="Search by name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <Button onClick={() => { setForm(EMPTY_FORM); setModalOpen(true); }}>Add contact</Button>
        <Button variant="secondary" onClick={() => setImportOpen(true)}>Import CSV</Button>
        <a href="/api/sms/contacts/export" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Export CSV
        </a>
        <Button
          variant="danger"
          onClick={() => { setDeleteAllConfirmText(""); setDeleteAllOpen(true); }}
          disabled={loading || total === 0}
        >
          Delete all ({total})
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-6 py-3">Name</th>
              <th className="px-4 py-3">Phone number</th>
              <th className="px-4 py-3">Opt-out</th>
              <th className="px-4 py-3 text-right">Messages</th>
              <th className="px-4 py-3">Added</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={6} className="px-6 py-10 text-center text-sm text-slate-400">Loading…</td></tr>
            ) : contacts.length === 0 ? (
              <tr><td colSpan={6} className="px-6 py-10 text-center text-sm text-slate-400">No contacts found. Add or import some.</td></tr>
            ) : (
              contacts.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 font-medium text-slate-900">{c.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{c.phoneNumber}</td>
                  <td className="px-4 py-3">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
                      <input type="checkbox" checked={c.optOut} onChange={() => toggleOptOut(c)} />
                      {c.optOut ? <span className="font-medium text-red-600">Opted out</span> : <span className="text-slate-500">Subscribed</span>}
                    </label>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">{c._count?.messages ?? 0}</td>
                  <td className="px-4 py-3 text-slate-500">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td className="px-6 py-3 text-right">
                    <button
                      className="rounded-lg px-2 py-1 text-sm font-medium text-brand-600 hover:bg-brand-50"
                      onClick={() => { setForm({ id: c.id, name: c.name, phoneNumber: c.phoneNumber }); setModalOpen(true); }}
                    >
                      Edit
                    </button>
                    <button
                      className="ml-1 rounded-lg px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50"
                      onClick={() => setDeleteTarget(c)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-slate-500">{total} contacts · page {page} of {pages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => load(page - 1, search)}>Previous</Button>
            <Button variant="secondary" disabled={page >= pages} onClick={() => load(page + 1, search)}>Next</Button>
          </div>
        </div>
      ) : null}

      {/* Add/Edit modal */}
      <Modal
        title={form.id ? "Edit contact" : "Add contact"}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !form.name || !form.phoneNumber}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="ct-name">Name</Label>
            <TextInput id="ct-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ct-phone">Phone number (E.164)</Label>
            <TextInput id="ct-phone" value={form.phoneNumber} onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
              placeholder="+12025550123" />
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        title="Delete contact?"
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
          Delete <strong>{deleteTarget?.name}</strong> ({deleteTarget?.phoneNumber})? This cannot be undone.
        </p>
      </Modal>

      {/* Delete-all confirmation */}
      <Modal
        title="Delete ALL contacts?"
        open={deleteAllOpen}
        onClose={() => !deletingAll && setDeleteAllOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteAllOpen(false)} disabled={deletingAll}>Cancel</Button>
            <Button variant="danger" onClick={confirmDeleteAll} disabled={deletingAll || deleteAllConfirmText !== "DELETE"}>
              {deletingAll ? "Deleting…" : `Delete all ${total} contacts`}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          This permanently deletes <strong>all {total} contacts</strong> for your account.
          Message history is kept, but recipients cannot be messaged again unless re-added.
          This cannot be undone.
        </p>
        <div className="mt-4">
          <Label>Type DELETE to confirm</Label>
          <TextInput
            value={deleteAllConfirmText}
            onChange={(e) => setDeleteAllConfirmText(e.target.value)}
            placeholder="DELETE"
            aria-label="Type DELETE to confirm"
          />
        </div>
      </Modal>

      {/* Import modal */}
      <Modal
        title="Import contacts from CSV"
        open={importOpen}
        onClose={() => setImportOpen(false)}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button onClick={runImport} disabled={saving || !csvText.trim()}>{saving ? "Importing…" : "Import"}</Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-600">
          Columns: <code className="rounded bg-slate-100 px-1">name</code> (or full_name),{" "}
          <code className="rounded bg-slate-100 px-1">phone</code> (or phone_number), optional{" "}
          <code className="rounded bg-slate-100 px-1">opt_out</code>.
          Existing numbers are updated.
        </p>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => onFilePicked(e.target.files?.[0])} className="mb-3 block text-sm" />
        <textarea
          rows={8}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={"name,phone\nJane Doe,+12025550123\nJohn Smith,+12025550145"}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-brand-500 focus:outline-none"
        />
      </Modal>
    </div>
  );
}
