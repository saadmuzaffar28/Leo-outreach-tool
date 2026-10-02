"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Label, TextInput, Alert } from "@/components/ui";

export function SuppressionManager({
  initial,
}: {
  initial: { id: string; email: string; reason: string | null }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/suppressions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add");
      setEmail("");
      setReason("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/suppressions/${id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  return (
    <div>
      <form onSubmit={add} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label>Email to suppress</Label>
          <TextInput
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="someone@example.com"
          />
        </div>
        <div className="flex-1">
          <Label>Reason (optional)</Label>
          <TextInput
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="opted out, unsubscribed…"
          />
        </div>
        <Button type="submit" disabled={busy}>
          Add to suppression
        </Button>
      </form>
      {error ? (
        <div className="mt-3">
          <Alert kind="error">{error}</Alert>
        </div>
      ) : null}

      {initial.length > 0 ? (
        <div className="mt-5 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {initial.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2">{s.email}</td>
                  <td className="px-4 py-2 text-slate-500">{s.reason ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => remove(s.id)}
                      className="rounded-md px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-500">
          No suppressed contacts. Recipients who opt out via the unsubscribe link appear here
          automatically.
        </p>
      )}
    </div>
  );
}