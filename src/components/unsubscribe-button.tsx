"use client";

import { useState } from "react";
import { Button, Alert } from "@/components/ui";

export function UnsubscribeButton({
  userId,
  email,
  signature,
}: {
  userId: string;
  email: string;
  signature: string;
}) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("u", userId);
      form.set("e", email);
      form.set("s", signature);
      const res = await fetch("/api/unsubscribe", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Alert kind="success">
        You have been unsubscribed. {email} will not receive further outreach from us.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Button onClick={confirm} disabled={busy}>
        {busy ? "Processing…" : "Yes, unsubscribe me"}
      </Button>
      <p className="text-xs text-slate-400">
        You can close this page — no change will be made unless you confirm.
      </p>
    </div>
  );
}