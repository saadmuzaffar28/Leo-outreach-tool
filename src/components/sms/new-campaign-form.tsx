"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/modal";
import { Button, Label, TextInput, TextArea } from "@/components/ui";
import { useToast } from "@/components/sms/toast";

interface ContactOption {
  id: string;
  name: string;
  phoneNumber: string;
  optOut: boolean;
}

interface SmsTemplateOption {
  id: string;
  name: string;
  message: string;
}

const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€".split(""),
);

/** Estimate SMS segments (GSM-7: 160/153, UCS-2: 70/67). */
export function estimateSegments(text: string): { segments: number; encoding: "GSM7" | "UCS2" } {
  const isGsm = Array.from(text).every((ch) => GSM7.has(ch));
  const len = Array.from(text).length;
  if (isGsm) {
    return { segments: len === 0 ? 0 : len <= 160 ? 1 : Math.ceil(len / 153), encoding: "GSM7" };
  }
  return { segments: len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67), encoding: "UCS2" };
}

export function NewCampaignForm({ defaultSource }: { defaultSource: string }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState(defaultSource);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [templates, setTemplates] = useState<SmsTemplateOption[]>([]);
  const [templateId, setTemplateId] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sms/templates");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { templates: SmsTemplateOption[] };
        if (!cancelled) setTemplates(data.templates);
      } catch {
        if (!cancelled) setTemplates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sms/contacts?pageSize=100");
        if (!res.ok) throw new Error("Failed to load contacts");
        const data = (await res.json()) as { contacts: ContactOption[] };
        if (!cancelled) setContacts(data.contacts.filter((c) => !c.optOut));
      } catch {
        if (!cancelled) toast.push("Could not load contacts", "error");
      } finally {
        if (!cancelled) setLoadingContacts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => c.name.toLowerCase().includes(q) || c.phoneNumber.includes(q),
    );
  }, [contacts, search]);

  const { segments, encoding } = useMemo(() => estimateSegments(message), [message]);
  const recipientCount = selected.size;
  const estimatedMessages = recipientCount * segments;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/sms/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          message,
          source,
          contactIds: Array.from(selected),
          sendNow,
          scheduledAt: sendNow ? undefined : new Date(scheduledAt).toISOString(),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        sent?: number;
        failed?: number;
        skippedOptedOut?: number;
        mode?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to create campaign");
      toast.push(
        sendNow
          ? `Campaign sent (${data.sent ?? 0} queued via ${data.mode ?? "8x8"}, ${data.failed ?? 0} failed)`
          : "Campaign scheduled",
        "success",
      );
      window.location.href = "/sms/campaigns";
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Something went wrong", "error");
      setSubmitting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <div>
          <Label htmlFor="camp-name">Campaign name</Label>
          <TextInput id="camp-name" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. March invoice reminders" maxLength={120} />
        </div>

        <div>
          <Label htmlFor="camp-template">Start from a template (optional)</Label>
          <select
            id="camp-template"
            value={templateId}
            onChange={(e) => {
              const id = e.target.value;
              setTemplateId(id);
              const t = templates.find((x) => x.id === id);
              if (t) setMessage(t.message);
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          >
            <option value="">— Write a new message —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="camp-msg">Message</Label>
          <TextArea id="camp-msg" rows={5} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="Hi {{name}}, this is Leo's outreach…" maxLength={1600} />
          <p className="mt-1 text-xs text-slate-500">
            {Array.from(message).length} characters · {segments} segment{segments === 1 ? "" : "s"} ({encoding}) · use {"{{name}}"} to personalize
          </p>
        </div>

        <div>
          <Label htmlFor="camp-source">Sending phone number / sender ID</Label>
          <TextInput id="camp-source" value={source} onChange={(e) => setSource(e.target.value)}
            placeholder="+12025550123 or StarBill" maxLength={20} />
        </div>

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-slate-700">When to send</legend>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="when" checked={sendNow} onChange={() => setSendNow(true)} />
              Send now
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="when" checked={!sendNow} onChange={() => setSendNow(false)} />
              Schedule
            </label>
            {!sendNow ? (
              <TextInput type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}
                className="w-64" aria-label="Scheduled date and time" />
            ) : null}
          </div>
        </fieldset>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Recipients ({recipientCount} selected)</Label>
            <button type="button" onClick={() => setSelected(new Set(filtered.map((c) => c.id)))}
              className="text-xs font-medium text-brand-600 hover:underline">
              Select all shown
            </button>
          </div>
          <TextInput placeholder="Search contacts…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
            {loadingContacts ? (
              <p className="px-4 py-6 text-center text-sm text-slate-400">Loading contacts…</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-400">No opted-in contacts found. Add contacts first.</p>
            ) : (
              filtered.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="font-medium text-slate-800">{c.name}</span>
                  <span className="ml-auto text-slate-500">{c.phoneNumber}</span>
                </label>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Live preview */}
      <div className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Preview</h3>
          </div>
          <div className="px-5 py-4">
            <div className="max-w-full rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-3 text-sm text-slate-800">
              {message ? message.replace(/\{\{\s*name\s*\}\}/gi, "Jane") : "Your message preview appears here…"}
            </div>
            <dl className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Recipients</dt><dd className="font-medium">{recipientCount}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Segments each</dt><dd className="font-medium">{segments}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Estimated messages</dt><dd className="font-medium">{estimatedMessages}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Send</dt><dd className="font-medium">{sendNow ? "Immediately" : scheduledAt || "—"}</dd></div>
            </dl>
            <Button className="mt-4 w-full" disabled={!name || !message || recipientCount === 0 || submitting}
              onClick={() => setConfirming(true)}>
              {submitting ? "Working…" : "Review & send"}
            </Button>
          </div>
        </div>
      </div>

      <Modal
        title={sendNow ? "Confirm & send campaign" : "Confirm & schedule campaign"}
        open={confirming}
        onClose={() => !submitting && setConfirming(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={submitting}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? "Sending…" : sendNow ? "Send now" : "Schedule"}
            </Button>
          </>
        }
      >
        <ul className="space-y-2 text-sm text-slate-700">
          <li><strong>{name || "Untitled"}</strong></li>
          <li>{recipientCount} recipients · ~{estimatedMessages} SMS messages ({encoding})</li>
          {!sendNow && scheduledAt ? <li>Scheduled for {new Date(scheduledAt).toLocaleString()}</li> : null}
          <li className="rounded-lg bg-slate-50 px-3 py-2 italic">“{message.replace(/\{\{\s*name\s*\}\}/gi, "Jane")}”</li>
          <li className="text-xs text-slate-500">Opted-out contacts are excluded automatically.</li>
        </ul>
      </Modal>
    </div>
  );
}
