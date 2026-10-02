"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Label, TextInput, TextArea, Alert, Card, inputClass } from "@/components/ui";
import { TEMPLATE_VARIABLES, personalize, PREVIEW_LEAD, findUnresolvedVariables } from "@/lib/personalization";

type TemplateInput = {
  name: string;
  subject: string;
  body: string;
  useSignature: boolean;
  signatureOverride: string;
};

type Field = "subject" | "body";

export function TemplateEditor({
  id,
  initial,
}: {
  id?: string;
  initial?: TemplateInput;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [useSignature, setUseSignature] = useState(initial?.useSignature ?? true);
  const [signatureOverride, setSignatureOverride] = useState(initial?.signatureOverride ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusedField, setFocusedField] = useState<Field | null>(null);

  const [testTo, setTestTo] = useState("");
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const previewSubject = personalize(subject, PREVIEW_LEAD).trim();
  const previewBody = personalize(body, PREVIEW_LEAD);
  const unresolved = findUnresolvedVariables(previewSubject + "\n" + previewBody);

  function insertVariable(key: string) {
    const target: Field = focusedField === "subject" ? "subject" : "body";
    const token = `{{${key}}}`;
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    if (target === "subject") setSubject(next);
    else setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(id ? `/api/templates/${id}` : "/api/templates", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          subject,
          body,
          useSignature,
          signatureOverride,
        } satisfies TemplateInput),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      router.push("/templates");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function sendTest() {
    setTestBusy(true);
    setTestNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/templates/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: testTo.trim(),
          template: { subject, body, useSignature, signatureOverride },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Send failed");
      setTestNotice(`Test email sent to ${data.to}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <Alert kind="error">{error}</Alert> : null}
      {testNotice ? <Alert kind="success">{testNotice}</Alert> : null}
      <Card className="p-6">
        <div className="space-y-4">
          <div>
            <Label>Template name</Label>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue Cycle Review" />
          </div>
          <div>
            <Label>Subject</Label>
            <input
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onFocus={() => setFocusedField("subject")}
              placeholder="Revenue Cycle Review"
              className={inputClass}
            />
          </div>
          <div>
            <Label>Body</Label>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onFocus={() => setFocusedField("body")}
              rows={14}
              placeholder={"Hi {{first_name}},\n\n..."}
              className={inputClass}
            />
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <p className="mb-2 text-sm font-medium text-slate-700">Personalization variables</p>
        <p className="mb-3 text-xs text-slate-500">
          Click a variable to insert it at the cursor in the{" "}
          {focusedField === "subject" ? (
            <span className="font-semibold text-slate-700">subject</span>
          ) : (
            <span className="font-semibold text-slate-700">body</span>
          )}{" "}
          field.
        </p>
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_VARIABLES.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => insertVariable(v.key)}
              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700"
              title={v.description}
            >
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <p className="mb-2 text-sm font-medium text-slate-700">
          Live preview <span className="font-normal text-slate-400">(sample lead: John Smith · ABC Medical Group)</span>
        </p>
        <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-800">
            Subject: {previewSubject || "—"}
          </p>
          <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">
            {previewBody}
          </pre>
        </div>
        {unresolved.length > 0 ? (
          <div className="mt-3">
            <Alert kind="error">
              Unresolved variables remain (these will block campaign launch):{" "}
              <span className="font-mono">{unresolved.join(", ")}</span>
            </Alert>
          </div>
        ) : null}
      </Card>

      <Card className="p-6">
        <p className="mb-2 text-sm font-medium text-slate-700">Send test email</p>
        <p className="mb-3 text-xs text-slate-500">
          Sends this template (personalized with the sample lead) straight to an inbox. The subject is prefixed with{" "}
          <span className="font-mono">[TEST]</span> and is never counted in campaign statistics.
        </p>
        <div className="flex gap-2">
          <TextInput
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
          />
          <Button type="button" onClick={sendTest} disabled={testBusy || !testTo.trim() || !subject.trim() || !body.trim()}>
            {testBusy ? "Sending…" : "Send test"}
          </Button>
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.push("/templates")}>
          Cancel
        </Button>
        <Button onClick={save} disabled={busy || !name || !subject || !body}>
          {busy ? "Saving…" : id ? "Save changes" : "Create template"}
        </Button>
      </div>
    </div>
  );
}