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

export interface GroupOption {
  id: string;
  name: string;
  contactCount: number;
}

export function CampaignForm({
  accounts,
  templates,
  groups = [],
  initialTemplateId = "",
  defaultSenderName = "",
}: {
  accounts: SenderOption[];
  templates: TemplateOption[];
  groups?: GroupOption[];
  initialTemplateId?: string;
  /** Server-provided fallback (the SENDER_NAME env value) pre-filled for the operator to edit. */
  defaultSenderName?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  // With exactly one connected account there is nothing to choose, so start
  // preselected. With two or more the operator must pick deliberately -- a
  // silent default could send from the wrong mailbox.
  const [senderId, setSenderId] = useState(
    accounts.length === 1 ? `${accounts[0].provider}:${accounts[0].id}` : "",
  );
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [groupId, setGroupId] = useState<string>("");
  // Pre-filled with the global default so the operator sees and edits the real
  // value instead of guessing it. Cleared entirely means "use the global default",
  // so a blank field is a deliberate opt-out rather than an empty sender name.
  const [senderName, setSenderName] = useState(defaultSenderName);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function senderState() {
    const first = senderId.split(":")[0] ?? "";
    const provider = first === "google" || first === "microsoft" || first === "smtp" ? first : "google";
    const accountId = senderId.includes(":") ? senderId.split(":").slice(1).join(":") : "";
    return { provider, accountId };
  }

  const selectedGroup = groups.find((g) => g.id === groupId) ?? null;

  // Recipient count follows the selector: the group's own count when one is
  // chosen, otherwise every lead in the list. The server re-resolves the real
  // list at send time, so this is a preview, not the source of truth.
  useEffect(() => {
    if (selectedGroup) {
      setLeadCount(selectedGroup.contactCount);
      return;
    }
    fetch("/api/leads/summary")
      .then((r) => r.json())
      .then((d) => setLeadCount(d.total ?? 0))
      .catch(() => setLeadCount(0));
  }, [selectedGroup]);

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
        body: JSON.stringify({
          name,
          templateId,
          ...accountField,
          ...(groupId ? { recipientGroupId: groupId } : {}),
          ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
        }),
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
            <Label>Sending Gmail account</Label>
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
                {accounts.length > 1 ? <option value="">Select account…</option> : null}
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
            <Label>Sender name</Label>
            <TextInput
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Leo's outreach"
              maxLength={80}
            />
            <p className="mt-1 text-xs text-slate-500">
              The display name recipients see, e.g.{" "}
              <span className="font-mono">Leo&apos;s Outreach &lt;{accounts[0]?.email ?? "you@example.com"}&gt;</span>
              . This campaign only — it does not change other campaigns or your
              Gmail account name. Leave blank to use the default.
            </p>
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
          <div>
            <Label>Recipients</Label>
            <p className="mb-1.5 text-xs text-slate-500">Source</p>
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">All contacts (everyone in your list)</option>
              {groups.length > 0 ? (
                <optgroup label="Groups">
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.contactCount})
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>

            {selectedGroup ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm">
                <div>
                  <p className="font-semibold text-slate-900">{selectedGroup.name}</p>
                  <p className="text-xs text-slate-500">
                    {selectedGroup.contactCount} contact
                    {selectedGroup.contactCount === 1 ? "" : "s"}
                  </p>
                </div>
                <Link
                  href={`/leads?tab=email&group=${encodeURIComponent(selectedGroup.id)}`}
                  className="text-sm font-medium text-brand-600 hover:underline"
                >
                  View contacts
                </Link>
              </div>
            ) : (
              <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                Recipients:{" "}
                <span className="font-semibold text-slate-900">
                  {leadCount === null ? "checking…" : `${leadCount} lead(s)`}
                </span>{" "}
                in your list. Select a group to target just that segment.
              </div>
            )}
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