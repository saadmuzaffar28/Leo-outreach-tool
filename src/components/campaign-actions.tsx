"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert, Label, Select } from "@/components/ui";
import { Modal } from "@/components/modal";

interface PreviewValidation {
  ok: boolean;
  errors: string[];
}

interface PreviewData {
  templateId: string | null;
  templateName: string | null;
  subject: string;
  body: string;
  validation: PreviewValidation;
  recipientCount: number;
  validRecipientCount: number;
  suppressedCount: number;
  duplicatesRemoved: number;
  googleEmail: string | null;
  senderName: string;
  senderEmail: string | null;
  senderProvider: "google" | "microsoft" | null;
  estimatedDuration: string;
  sampleRecipients: string[];
  sendMode?: "live" | "test";
}

interface TemplateOption {
  id: string;
  name: string;
}

export function CampaignActions({ campaignId, status }: { campaignId: string; status: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [switchingTemplate, setSwitchingTemplate] = useState(false);
  const [loadingStart, setLoadingStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmStart() {
    setError(null);
    setLoadingStart(true);
    try {
      const [previewRes, templatesRes] = await Promise.all([
        fetch(`/api/campaigns/${campaignId}/preview`),
        fetch("/api/templates"),
      ]);
      const [previewData, templatesData] = await Promise.all([previewRes.json(), templatesRes.json()]);
      if (!previewRes.ok) throw new Error(previewData.error ?? "Preview failed");
      setPreview(previewData);
      setTemplates((templatesData.templates ?? []).map((t: TemplateOption) => ({ id: t.id, name: t.name })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingStart(false);
    }
  }

  async function switchTemplate(templateId: string) {
    if (!templateId) return;
    setSwitchingTemplate(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not change template");
      const previewRes = await fetch(`/api/campaigns/${campaignId}/preview`);
      const previewData = await previewRes.json();
      if (!previewRes.ok) throw new Error(previewData.error ?? "Preview failed");
      setPreview(previewData);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSwitchingTemplate(false);
    }
  }

  async function act(action: "start" | "pause" | "resume" | "stop") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed");
      setPreview(null);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canStart =
    preview !== null && preview.validation.ok && preview.validRecipientCount > 0;

  return (
    <div className="space-y-3">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        {(status === "draft" || status === "stopped") && (
          <Button onClick={confirmStart} disabled={loadingStart}>
            {loadingStart ? "Preparing…" : "Preview & start"}
          </Button>
        )}
        {status === "active" && (
          <>
            <Button variant="secondary" onClick={() => act("pause")} disabled={busy}>
              Pause
            </Button>
            <Button variant="danger" onClick={() => act("stop")} disabled={busy}>
              Stop
            </Button>
          </>
        )}
        {status === "paused" && (
          <>
            <Button onClick={() => act("resume")} disabled={busy}>
              Resume
            </Button>
            <Button variant="danger" onClick={() => act("stop")} disabled={busy}>
              Stop
            </Button>
          </>
        )}
      </div>

      <Modal
        title="Preview & safety review"
        open={preview !== null}
        onClose={() => setPreview(null)}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button onClick={() => act("start")} disabled={busy || !canStart}>
              {busy ? "Starting…" : "Yes, start sending"}
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-slate-100 p-4">
              <Label>Email template</Label>
              {templates.length > 0 ? (
                <Select
                  value={preview.templateId ?? ""}
                  onChange={(e) => switchTemplate(e.target.value)}
                  disabled={switchingTemplate}
                >
                  <option value="">Select template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-xs text-slate-500">Create a template first.</p>
              )}
            </div>

            {preview.validation.ok ? (
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-800">
                  Subject: {preview.subject || "—"}
                </p>
                <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">
                  {preview.body}
                </pre>
              </div>
            ) : (
              <Alert kind="error">
                This template can&apos;t be used yet:{" "}
                <span className="font-medium">{preview.validation.errors.join(" ")}</span>
              </Alert>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="flex justify-between">
                  <span className="text-slate-500">Recipients (leads)</span>
                  <span className="font-semibold text-slate-900">{preview.recipientCount}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-slate-500">Will send</span>
                  <span className="font-semibold text-emerald-600">{preview.validRecipientCount}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-slate-500">Suppressed, skipped</span>
                  <span className="font-semibold text-slate-600">{preview.suppressedCount}</span>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Sending from</span>
                  <span className="truncate font-semibold text-slate-900">
                    {preview.senderName} &lt;{preview.senderEmail ?? preview.googleEmail ?? "—"}&gt;
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-slate-500">Provider</span>
                  <span className="font-semibold text-slate-900 capitalize">{preview.senderProvider ?? "—"}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-slate-500">Estimated duration</span>
                  <span className="font-semibold text-slate-900">{preview.estimatedDuration}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-slate-500">Mode</span>
                  <span className="font-semibold text-slate-900 capitalize">{preview.sendMode}</span>
                </div>
              </div>
            </div>

            {preview.sampleRecipients.length > 0 ? (
              <div>
                <p className="mb-1 text-xs uppercase text-slate-400">Sample recipients</p>
                <ul className="space-y-0.5 text-slate-600">
                  {preview.sampleRecipients.map((email) => (
                    <li key={email}>{email}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <Alert kind="error">No recipients found. Import leads first.</Alert>
            )}
            {preview.sendMode === "test" ? (
              <Alert kind="error">
                TEST MODE is ON — no emails will actually be sent. The worker will simulate delivery and log what it
                would have sent.
              </Alert>
            ) : null}
            {preview.validRecipientCount === 0 ? (
              <Alert kind="error">
                No valid recipients to send to. Add leads or remove suppressions first.
              </Alert>
            ) : null}
            <p className="text-xs text-slate-400">
              Emails are sent through the connected email provider (Gmail or Outlook) at the configured pace (see
              Sending limits in Settings).
              The message content is snapshotted when the campaign starts, so later template edits won&apos;t change
              what is sent. The send worker must be running for delivery to start.
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}