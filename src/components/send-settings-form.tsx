"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Label, Select, TextInput } from "@/components/ui";

export interface SendSettingsFormData {
  dailySendLimit: number;
  messagesPerMinute: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  maxRetryAttempts: number;
  baseRetryDelaySeconds: number;
  maxRetryDelaySeconds: number;
  sendMode: "live" | "test";
}

export function SendSettingsForm({ initial }: { initial: SendSettingsFormData }) {
  const router = useRouter();
  const [form, setForm] = useState<SendSettingsFormData>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(key: keyof SendSettingsFormData, value: string) {
    setSaved(false);
    setForm((f) => ({
      ...f,
      [key]:
        key === "sendMode"
          ? (value as SendSettingsFormData["sendMode"])
          : value === ""
            ? (f[key] as number)
            : Number(value),
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailySendLimit: form.dailySendLimit,
          messagesPerMinute: form.messagesPerMinute,
          minDelaySeconds: form.minDelaySeconds,
          maxDelaySeconds: form.maxDelaySeconds,
          maxRetryAttempts: form.maxRetryAttempts,
          baseRetryDelaySeconds: form.baseRetryDelaySeconds,
          maxRetryDelaySeconds: form.maxRetryDelaySeconds,
          sendMode: form.sendMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save settings");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, key: keyof SendSettingsFormData, hint?: string, min = 1) => (
    <div>
      <Label>{label}</Label>
      <TextInput
        type="number"
        min={min}
        value={String(form[key])}
        onChange={(e) => patch(key, e.target.value)}
      />
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );

  return (
    <div className="space-y-4">
      {error ? <Alert kind="error">{error}</Alert> : null}
      {saved ? <Alert kind="success">Sending settings saved and applied to the worker.</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "Daily send limit (per Gmail account)",
          "dailySendLimit",
          "Campaigns are paused once today's sends hit this limit. Conservative default of 100.",
        )}
        {field("Messages per minute", "messagesPerMinute", "Token-bucket allowance for short bursts.")}
        {field("Minimum delay (seconds)", "minDelaySeconds", "Hard spacing between individual sends — this is the pace-setting knob.")}
        {field("Maximum delay (seconds)", "maxDelaySeconds", "Cap on auto-resume backoff after sustained Gmail rate limiting.")}
        {field("Max retry attempts", "maxRetryAttempts", "Applies to temporary errors only; start from 0.", 0)}
        {field("Base retry delay (seconds)", "baseRetryDelaySeconds", "First retry starts here; each retry doubles.")}
        {field("Max retry delay (seconds)", "maxRetryDelaySeconds", "Ceiling for exponential backoff.")}
        <div>
          <Label>Send mode</Label>
          <Select value={form.sendMode} onChange={(e) => patch("sendMode", e.target.value)}>
            <option value="live">Live — send real email via Gmail</option>
            <option value="test">Test — simulate, never call Gmail</option>
          </Select>
          <p className="mt-1 text-xs text-slate-400">
            Test mode processes the queue normally but logs each simulated send instead of delivering it.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save sending settings"}
        </Button>
      </div>
    </div>
  );
}