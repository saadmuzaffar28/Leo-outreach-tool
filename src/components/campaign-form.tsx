"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Label, TextInput, Select, Alert, Card } from "@/components/ui";
import Link from "next/link";

export interface SenderOption {
  id: string;
  provider: "google" | "microsoft" | "smtp";
  email: string;
}

export interface TemplateOption {
  id: string;
  name: string;
  subject: string;
  body: string;
}

export function CampaignForm({
  accounts,
  templates,
  initialTemplateId = "",
}: {
  accounts: SenderOption[];
  templates: TemplateOption[];
  initialTemplateId?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [senderId, setSenderId] = useState("");
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function senderState() {
    const first = senderId.split(":")[0] ?? "";
    const provider = first === "google" || first === "microsoft" || first === "smtp" ? first : "google";
    const accountId = senderId.includes(":") ? senderId.split(":").slice(1).join(":") : "";
    return { provider, accountId };
  }

  useEffect(() => {
    fetch("/api/leads/summary")
      .then((r) => r.json())
      .then((d) => setLeadCount(d.total ?? 0))
      .catch(() => setLeadCount(0));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { provider, accountId } = senderState();
      const accountField =
        provider === "google" ? { googleAccountId: accountId }
          : provider === "microsoft" ? { microsoftAccountId: accountId }
            : { smtpAccountId: accountId };
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, templateId, ...accountField }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Create failed");
      router.push(`/campaigns/${data.campaign.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const selectedTemplate = templates.find((t) => t.id === templateId);

  return (
    <form onSubmit={create} className="space-y-6">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Card className="p-6">
        <div className="space-y-4">
          <div>
            <Label>Campaign name</Label>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q3 RCM Outreach"
              required
            />
          </div>
          <div>
            <Label>Sending account (From)</Label>
            {accounts.length === 0 ? (
              <Alert kind="error">
                No sending account connected.{" "}
                <Link href="/settings" className="font-medium underline">
                  Connect Gmail, Outlook, or SMTP in Settings
                </Link>
                .
              </Alert>
            ) : (
              <Select value={senderId} onChange={(e) => setSenderId(e.target.value)} required>
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={`${a.provider}:${a.id}`} value={`${a.provider}:${a.id}`}>
                    {a.email} ·{" "}
                    {a.provider === "microsoft"
                      ? "Outlook"
                      : a.provider === "smtp"
                        ? "SMTP"
                        : "Gmail"}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <div>
            <Label>Email template</Label>
            {templates.length === 0 ? (
              <Alert kind="error">
                No templates yet.{" "}
                <Link href="/templates/new" className="font-medium underline">
                  Create one
                </Link>
                .
              </Alert>
            ) : (
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
                <option value="">Select template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
            {selectedTemplate ? (
              <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">Template preview</p>
                <p className="mt-1 font-medium text-slate-800">Subject: {selectedTemplate.subject}</p>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-600">
                  {selectedTemplate.body}
                </pre>
              </div>
            ) : null}
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            Recipients:{" "}
            <span className="font-semibold text-slate-900">
              {leadCount === null ? "checking…" : `${leadCount} lead(s)`}
            </span>{" "}
            in your list. A campaign sends to every lead.
          </div>
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => router.push("/campaigns")}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            busy || !name || !senderId || !templateId || (leadCount !== null && leadCount === 0)
          }
        >
          {busy ? "Creating…" : "Create campaign"}
        </Button>
      </div>
    </form>
  );
}