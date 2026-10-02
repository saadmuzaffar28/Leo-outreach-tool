"use client";

import { useState } from "react";
import { Button, Label, TextArea, Alert } from "@/components/ui";

export function AccountSignatureEditor({
  accountId,
  email,
  initial,
  hasGmailSignature,
}: {
  accountId: string;
  email: string;
  initial: string;
  hasGmailSignature: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(`/api/google/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureOverride: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-3">
      <Label>{value.trim() ? "Custom signature (overrides Gmail)" : "Add a custom signature"}</Label>
      <TextArea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder={"Leo Collins\nLeo's outreach\nleo@starbillingsolutions.com"}
      />
      <p className="mt-1 text-xs text-slate-400">
        Used on outgoing emails for {email}.{" "}
        {value.trim()
          ? "This replaces the signature saved in Gmail."
          : hasGmailSignature
            ? "Without it, the signature captured from Gmail is used."
            : "Without it, no signature is appended."}
      </p>
      {error ? <div className="mt-2"><Alert kind="error">{error}</Alert></div> : null}
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save signature"}
        </Button>
        {saved ? <span className="text-xs text-emerald-600">Saved.</span> : null}
      </div>
    </div>
  );
}