"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Label, TextInput, Select, Alert, Card } from "@/components/ui";
import Link from "next/link";
import { SmtpMailboxSelect, type SmtpMailboxOption } from "@/components/smtp-mailbox-select";

export interface SenderOption extends SmtpMailboxOption {
  provider: "google" | "microsoft" | "smtp";
  /** SmtpAccount.status ("connected" = eligible). Absent is treated as connected. */
  status?: string;
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

type SenderProvider = "smtp" | "google" | "microsoft";

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

  const smtpAccounts = accounts.filter((a) => a.provider === "smtp");
  const googleAccounts = accounts.filter((a) => a.provider === "google");
  const microsoftAccounts = accounts.filter((a) => a.provider === "microsoft");
  // Only connected/healthy SMTP mailboxes are selectable — a mailbox that
  // failed its last test cannot be added to a campaign.
  const smtpMailboxes = smtpAccounts.filter((a) => (a.status ?? "connected") === "connected");
  const hasAnySender =
    smtpMailboxes.length > 0 || googleAccounts.length > 0 || microsoftAccounts.length > 0;

  const [name, setName] = useState("");
  // Default provider mirrors the old behaviour — pick the only populated family;
  // with two or more the operator must choose deliberately.
  const [senderProvider, setSenderProvider] = useState<SenderProvider>(() =>
    smtpMailboxes.length > 0
      ? "smtp"
      : googleAccounts.length > 0
        ? "google"
        : "microsoft",
  );
  // With exactly one eligible mailbox there is nothing to choose, so start
  // preselected. Otherwise begin empty — a silent default could send from the
  // wrong mailbox.
  const [smtpIds, setSmtpIds] = useState<string[]>(() =>
    smtpMailboxes.length === 1 && googleAccounts.length === 0 && microsoftAccounts.length === 0
      ? [smtpMailboxes[0].id]
      : [],
  );
  const [googleId, setGoogleId] = useState(() =>
    googleAccounts.length === 1 && smtpMailboxes.length === 0 && microsoftAccounts.length === 0
      ? googleAccounts[0].id
      : "",
  );
  const [microsoftId, setMicrosoftId] = useState(() =>
    microsoftAccounts.length === 1 && smtpMailboxes.length === 0 && googleAccounts.length === 0
      ? microsoftAccounts[0].id
      : "",
  );
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [groupId, setGroupId] = useState<string>("");
  // Pre-filled with the global default so the operator sees and edits the real
  // value instead of guessing it. Cleared entirely means "use the global default",
  // so a blank field is a deliberate opt-out rather than an empty sender na
  // [sic] — see SENDER_NAME resolution in the worker.
  const [senderName, setSenderName] = useState(defaultSenderName);
  const [verificationPolicy, setVerificationPolicy] = useState<
    "OFF" | "WARN" | "BLOCK_INVALID" | "BLOCK_INVALID_AND_RISKY"
  >("OFF");
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const senderValid =
    senderProvider === "smtp"
      ? smtpIds.length > 0
      : senderProvider === "google"
        ? Boolean(googleId)
        : Boolean(microsoftId);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const accountField =
        senderProvider === "smtp"
          ? { smtpAccountIds: smtpIds }
          : senderProvider === "google"
            ? { googleAccountId: googleId }
            : { microsoftAccountId: microsoftId };
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          templateId,
          ...accountField,
          ...(groupId ? { recipientGroupId: groupId } : {}),
          ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
          // Explicit even when OFF: existing campaigns stay OFF, but the form
          // always records the operator's choice (create schema defaults OFF).
          verificationPolicy,
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

          {!hasAnySender ? (
            <Alert kind="error">
              No sending account connected.{" "}
              <Link href="/settings" className="font-medium underline">
                Connect Gmail, Outlook, or SMTP in Settings
              </Link>
              .
            </Alert>
          ) : (
            <>
              <div>
                <Label>Sending provider</Label>
                <Select
                  value={senderProvider}
                  onChange={(e) => setSenderProvider(e.target.value as SenderProvider)}
                  required
                >
                  {smtpMailboxes.length > 0 ? <option value="smtp">SMTP mailboxes</option> : null}
                  {googleAccounts.length > 0 ? <option value="google">Gmail</option> : null}
                  {microsoftAccounts.length > 0 ? (
                    <option value="microsoft">Outlook</option>
                  ) : null}
                </Select>
              </div>

              {senderProvider === "smtp" ? (
                <div>
                  <Label>Sending mailboxes</Label>
                  <SmtpMailboxSelect
                    mailboxes={smtpMailboxes}
                    selected={smtpIds}
                    onChange={setSmtpIds}
                    leadCount={leadCount}
                  />
                  {smtpIds.length > 0 ? (
                    <p className="mt-1 text-xs text-slate-500">
                      Each mailbox sends only to the contacts it is assigned at
                      start — and appends its own signature.
                    </p>
                  ) : null}
                </div>
              ) : senderProvider === "google" ? (
                <div>
                  <Label>Sending Gmail account</Label>
                  <Select value={googleId} onChange={(e) => setGoogleId(e.target.value)} required>
                    {googleAccounts.length > 1 ? <option value="">Select account…</option> : null}
                    {googleAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email} · Gmail
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <div>
                  <Label>Sending Outlook account</Label>
                  <Select
                    value={microsoftId}
                    onChange={(e) => setMicrosoftId(e.target.value)}
                    required
                  >
                    {microsoftAccounts.length > 1 ? <option value="">Select account…</option> : null}
                    {microsoftAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email} · Outlook
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </>
          )}

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
              <span className="font-mono">
                Leo&apos;s Outreach &lt;{accounts[0]?.email ?? "you@example.com"}&gt;
              </span>
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

          <div>
            <Label>Verification gate</Label>
            <Select
              value={verificationPolicy}
              onChange={(e) =>
                setVerificationPolicy(
                  e.target.value as "OFF" | "WARN" | "BLOCK_INVALID" | "BLOCK_INVALID_AND_RISKY",
                )
              }
            >
              <option value="OFF">No verification check (default)</option>
              <option value="WARN">Warn only — show results, skip nothing</option>
              <option value="BLOCK_INVALID">Block verified-INVALID addresses</option>
              <option value="BLOCK_INVALID_AND_RISKY">
                Block INVALID, RISKY, UNKNOWN &amp; CATCH-ALL (deliverable-only)
              </option>
            </Select>
            <p className="mt-1 text-xs text-slate-500">
              {verificationPolicy === "OFF"
                ? "Sends exactly as today — verification results are never consulted."
                : verificationPolicy === "WARN"
                  ? "No address is skipped; verified results are shown in the campaign preview and recipient list."
                  : verificationPolicy === "BLOCK_INVALID"
                    ? "Recipients with a stored INVALID result are skipped and logged with the reason at send time."
                    : "Only addresses with a stored VALID result are sent to; everything else is skipped and logged. Unverified addresses are never blocked implicitly — they count in the preview so you can run a bulk verification first."}
            </p>
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
            busy || !name || !senderValid || !templateId || (leadCount !== null && leadCount === 0)
          }
        >
          {busy ? "Creating…" : "Create campaign"}
        </Button>
      </div>
    </form>
  );
}