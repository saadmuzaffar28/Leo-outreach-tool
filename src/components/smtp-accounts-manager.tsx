"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Label, TextInput, Select, Alert, Card } from "@/components/ui";

export interface SmtpAccountViewDTO {
  id: string;
  email: string;
  host: string;
  port: number;
  security: string;
  status: string;
  lastTestedAt: string | null;
  lastTestError: string | null;
  createdAt: string;
}

export const SMTP_SECURITY_LABELS: Record<string, string> = {
  ssl: "SSL/TLS (port 465)",
  starttls: "STARTTLS (port 587)",
  none: "No encryption (port 25)",
};

export function SmtpAccountsManager({ initial }: { initial: SmtpAccountViewDTO[] }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<SmtpAccountViewDTO[]>(initial);
  const [editing, setEditing] = useState<SmtpAccountViewDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("465");
  const [security, setSecurity] = useState("ssl");
  // Username is optional and, when editing, blank means "keep the stored one".
  const [username, setUsername] = useState("");
  // Password is NEVER pre-filled and never sent back from the server. On edit,
  // blank means "keep the stored password".
  const [password, setPassword] = useState("");

  function resetForm() {
    setEmail("");
    setHost("");
    setPort("465");
    setSecurity("ssl");
    setUsername("");
    setPassword("");
    setEditing(null);
  }

  function startEdit(a: SmtpAccountViewDTO) {
    setEditing(a);
    setEmail(a.email);
    setHost(a.host);
    setPort(String(a.port));
    setSecurity(a.security);
    setUsername("");
    setPassword("");
  }

  async function reload(): Promise<void> {
    const res = await fetch("/api/smtp/accounts");
    const data = (await res.json().catch(() => ({}))) as { accounts?: SmtpAccountViewDTO[] };
    setAccounts(data.accounts ?? []);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const method = editing ? "PATCH" : "POST";
    const url = editing ? `/api/smtp/accounts/${editing.id}` : "/api/smtp/accounts";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, host, port: Number(port), security, username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? data.code ?? "Save failed");
      }
      await reload();
      resetForm();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: SmtpAccountViewDTO) {
    if (!confirm(`Delete SMTP account ${a.email}? Campaigns using it will no longer send.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/smtp/accounts/${a.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Delete failed");
      }
      if (editing?.id === a.id) resetForm();
      await reload();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(a: SmtpAccountViewDTO) {
    setTestingId(a.id);
    setError(null);
    try {
      const res = await fetch("/api/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: a.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok && data.error) setError(data.error);
    } finally {
      await reload();
      setTestingId(null);
      router.refresh();
    }
  }

  return (
    <div className="px-6 py-4">
      {error ? (
        <div className="mb-4"><Alert kind="error">{error}</Alert></div>
      ) : null}

      {accounts.length === 0 && !editing ? (
        <p className="text-sm text-slate-500">
          No SMTP account connected yet. Add one below to send campaigns through your own mail server.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {accounts.map((a) => (
            <li key={a.id} className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium text-slate-900">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        a.status === "connected" ? "bg-emerald-500" : "bg-amber-500"
                      }`}
                    />
                    <span className="truncate">{a.email}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {a.host}:{a.port} · {SMTP_SECURITY_LABELS[a.security] ?? a.security} · status: {a.status}
                  </p>
                  {a.lastTestError ? (
                    <p className="mt-0.5 max-w-[420px] truncate text-xs text-red-500" title={a.lastTestError}>
                      {a.lastTestError}
                    </p>
                  ) : a.lastTestedAt ? (
                    <p className="mt-0.5 text-xs text-slate-400">
                      Last tested {new Date(a.lastTestedAt).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={testingId === a.id}
                    onClick={() => testConnection(a)}
                  >
                    {testingId === a.id ? "Testing…" : "Test connection"}
                  </Button>
                  <Button variant="secondary" onClick={() => startEdit(a)}>
                    Edit
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={() => remove(a)}>
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Card className="mt-4 border-dashed bg-slate-50">
        <form onSubmit={save} className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">
            {editing ? `Edit SMTP account — ${editing.email}` : "Add SMTP account"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>From email</Label>
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="andy@advancedmdmedicalbilling.com"
                required
              />
            </div>
            <div>
              <Label>SMTP host</Label>
              <TextInput
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="advancedmdmedicalbilling.com"
                required
              />
            </div>
            <div>
              <Label>Port</Label>
              <TextInput
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                required
              />
            </div>
            <div>
              <Label>Security</Label>
              <Select value={security} onChange={(e) => setSecurity(e.target.value)}>
                <option value="ssl">SSL/TLS (port 465)</option>
                <option value="starttls">STARTTLS (port 587)</option>
                <option value="none">No encryption (port 25)</option>
              </Select>
            </div>
            <div>
              <Label>Username (login)</Label>
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={editing ? "Leave blank to keep the stored username" : "andy@advancedmdmedicalbilling.com"}
              />
            </div>
            <div>
              <Label>Password</Label>
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  editing
                    ? "Leave blank to keep the stored password"
                    : "Encrypted at rest — never returned or logged"
                }
                required={!editing}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Password is AES-256-GCM-encrypted at rest, only decrypted in memory server-side to send
            or test, and never returned by the API.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={resetForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !email || !host}>
              {busy ? "Saving…" : editing ? "Save changes" : "Test & save"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}