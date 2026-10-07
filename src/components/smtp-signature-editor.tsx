"use client";

import { useRef, useState } from "react";
import { Button, Label, Alert } from "@/components/ui";
import { sanitizeSignatureHtml } from "@/lib/signature";

/**
 * Per-mailbox rich-text signature editor.
 *
 * Signatures belong to the SENDING ACCOUNT, so this editor is embedded next to
 * every connected SMTP mailbox in Settings. It stores sanitized HTML only (the
 * server sanitizes on save; the preview sanitizes again for defense-in-depth).
 * The editor is a tiny contentEditable toolbar (bold / italic / underline /
 * link / clear) — no new editor framework, email-safe HTML only.
 */
export function SmtpSignatureEditor({
  accountId,
  email,
  initialEnabled,
  initialHtml,
  onSaved,
}: {
  accountId: string;
  email: string;
  initialEnabled: boolean;
  initialHtml: string | null;
  onSaved: (enabled: boolean, html: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [html, setHtml] = useState(initialHtml ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  function exec(cmd: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    if (editorRef.current) setHtml(editorRef.current.innerHTML);
  }

  function insertLink() {
    const raw = window.prompt("Link URL (http://, https:// or mailto:)", "https://");
    if (!raw) return;
    const url = raw.trim();
    if (!/^(https?:|mailto:)/i.test(url)) {
      setError("Links must start with http://, https:// or mailto:");
      return;
    }
    setError(null);
    exec("createLink", url);
  }

  const previewHtml = sanitizeSignatureHtml(html);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(`/api/smtp/accounts/${accountId}/signature`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureEnabled: enabled, signatureHtml: html }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        account?: { signatureEnabled: boolean; signatureHtml: string | null };
      };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      onSaved(enabled, data.account?.signatureHtml ?? null);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <Label>
          Email signature for{" "}
          <span className="font-semibold text-slate-900">{email}</span>
        </Label>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setSaved(false);
            }}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Use signature
        </label>
      </div>

      {enabled ? (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-1">
            <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => exec("bold")}>
              <strong>B</strong>
            </Button>
            <Button type="button" variant="ghost" className="px-2 py-1 text-xs italic" onClick={() => exec("italic")}>
              I
            </Button>
            <Button type="button" variant="ghost" className="px-2 py-1 text-xs underline" onClick={() => exec("underline")}>
              U
            </Button>
            <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={insertLink}>
              Link
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={() => exec("removeFormat")}
              title="Clear formatting"
            >
              Clear
            </Button>
          </div>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            className="min-h-[90px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
            onInput={(e) => {
              setHtml((e.target as HTMLDivElement).innerHTML);
              setSaved(false);
            }}
            onBlur={() => {
              if (editorRef.current) setHtml(editorRef.current.innerHTML);
            }}
          />
          <p className="mt-1 text-xs text-slate-400">
            Bold, italic, underline and links are supported. Line breaks are kept.
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-400">
          Off — this mailbox sends without a signature. Turn it on to write one.
        </p>
      )}

      {showPreview ? (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-slate-500">Preview</p>
          {previewHtml ? (
            <div
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
              // Sanitizer is applied above, before this renders.
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <p className="text-xs text-slate-400">Nothing to preview yet.</p>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="mt-2"><Alert kind="error">{error}</Alert></div>
      ) : null}
      {saved ? (
        <div className="mt-2"><Alert kind="success">Signature saved for {email}.</Alert></div>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowPreview((v) => !v)}
        >
          {showPreview ? "Hide preview" : "Preview"}
        </Button>
        <Button
          type="button"
          disabled={busy || !enabled}
          onClick={save}
        >
          {busy ? "Saving…" : "Save Signature"}
        </Button>
      </div>
    </div>
  );
}