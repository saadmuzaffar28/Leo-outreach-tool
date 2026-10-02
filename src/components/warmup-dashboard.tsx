"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Label,
  Select,
  StatCard,
  StatusBadge,
  TextInput,
} from "@/components/ui";
import { Modal as ModalShell } from "@/components/modal";
import type {
  WarmupEventView,
  WarmupMailboxView,
  WarmupStatsView,
} from "@/lib/warmup/types";

/**
 * Warm-up dashboard.
 *
 * DESIGN COMMITMENT shown in the header banner: warm-up is a controlled
 * sending/ramp/verification mechanism. It does NOT guarantee inbox placement or
 * reputation, and finishing a ramp never raises a campaign send limit.
 */

const toneClasses = {
  ok: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  bad: "bg-red-50 text-red-700",
  muted: "bg-slate-100 text-slate-600",
} as const;

function statusBadge(m: WarmupMailboxView) {
  if (m.status === "paused_error") {
    return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses.bad}`}>Paused (error)</span>;
  }
  if (m.status === "running" && m.enabled) {
    return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses.ok}`}>Running</span>;
  }
  if (m.enabled) {
    return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses.warn}`}>Enabled</span>;
  }
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses.muted}`}>Disabled</span>;
}

function fmtDate(value: Date | string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function post(url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) return { ok: false, error: data.error ?? data.message ?? `Request failed (${res.status})` };
  return { ok: true };
}

async function patch(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false, error: data.error ?? `Request failed (${res.status})` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function SettingsDialog({
  mailbox,
  onClose,
  onSaved,
}: {
  mailbox: WarmupMailboxView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    startingDailyVolume: 5,
    maximumDailyVolume: 15,
    dailyIncrease: 1,
    minimumDelaySeconds: 60,
    maximumDelaySeconds: 120,
    warmupWindowStart: "09:00",
    warmupWindowEnd: "17:00",
    pauseOnError: true,
    maxConsecutiveFailures: 3,
  });
  const [imap, setImap] = useState({ host: "", port: 993, security: "ssl", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);

  useEffect(() => {
    if (!mailbox) return;
    setForm({
      startingDailyVolume: mailbox.startingDailyVolume,
      maximumDailyVolume: mailbox.maximumDailyVolume,
      dailyIncrease: mailbox.dailyIncrease,
      minimumDelaySeconds: mailbox.minimumDelaySeconds,
      maximumDelaySeconds: mailbox.maximumDelaySeconds,
      warmupWindowStart: mailbox.warmupWindowStart,
      warmupWindowEnd: mailbox.warmupWindowEnd,
      pauseOnError: mailbox.pauseOnError,
      maxConsecutiveFailures: mailbox.maxConsecutiveFailures,
    });
    setImap({
      host: "",
      port: 993,
      security: "ssl",
      username: "",
      password: "",
    });
    setError(null);
    setTestResult(null);
  }, [mailbox]);

  async function save() {
    if (!mailbox) return;
    setBusy(true);
    setError(null);
    const r = await patch(`/api/warmup/mailboxes/${mailbox.smtpAccountId}`, form);
    if (!r.ok) {
      setError(r.error ?? "Could not save");
      setBusy(false);
      return;
    }
    // Save IMAP config only when a host was typed, so an untouched password
    // field never blanks the stored one.
    if (imap.host.trim()) {
      const imapRes = await patch(`/api/warmup/mailboxes/${mailbox.smtpAccountId}/imap`, {
        imapHost: imap.host.trim(),
        imapPort: Number(imap.port),
        imapSecurity: imap.security,
        ...(imap.username.trim() ? { imapUsername: imap.username.trim() } : {}),
        ...(imap.password ? { imapPassword: imap.password } : {}),
      });
      if (!imapRes.ok) {
        setError(imapRes.error ?? "Warm-up settings saved, but IMAP configuration failed");
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onSaved();
    onClose();
  }

  async function testImap() {
    if (!mailbox) return;
    setBusy(true);
    setTestResult(null);
    // Persist first so the test runs against what the operator just typed.
    const imapRes = await patch(`/api/warmup/mailboxes/${mailbox.smtpAccountId}/imap`, {
      imapHost: imap.host.trim(),
      imapPort: Number(imap.port),
      imapSecurity: imap.security,
      ...(imap.username.trim() ? { imapUsername: imap.username.trim() } : {}),
      ...(imap.password ? { imapPassword: imap.password } : {}),
    });
    if (!imapRes.ok) {
      setTestOk(false);
      setTestResult(imapRes.error ?? "Could not save IMAP settings");
      setBusy(false);
      return;
    }
    const res = await fetch(`/api/warmup/mailboxes/${mailbox.smtpAccountId}/imap/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    setTestOk(Boolean(data.ok));
    setTestResult(data.message ?? (res.ok ? "IMAP works" : "IMAP test failed"));
    setBusy(false);
  }

  if (!mailbox) return null;
  const num = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value === "" ? 0 : Number(e.target.value) }));

  return (
    <ModalShell
      title={`Warm-up settings — ${mailbox.email}`}
      open={mailbox !== null}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error ? <Alert kind="error">{error}</Alert> : null}

        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-800">Daily ramp</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="wu-start">Starting daily volume</Label>
              <TextInput id="wu-start" type="number" min={1} max={200} value={form.startingDailyVolume} onChange={num("startingDailyVolume")} />
            </div>
            <div>
              <Label htmlFor="wu-increase">Daily increase</Label>
              <TextInput id="wu-increase" type="number" min={0} max={50} value={form.dailyIncrease} onChange={num("dailyIncrease")} />
            </div>
            <div>
              <Label htmlFor="wu-max">Maximum daily volume</Label>
              <TextInput id="wu-max" type="number" min={1} max={500} value={form.maximumDailyVolume} onChange={num("maximumDailyVolume")} />
            </div>
            <div>
              <Label htmlFor="wu-failures">Max consecutive failures before pause</Label>
              <TextInput id="wu-failures" type="number" min={1} max={50} value={form.maxConsecutiveFailures} onChange={num("maxConsecutiveFailures")} />
            </div>
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-800">Pacing and window</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="wu-mindelay">Minimum delay (seconds)</Label>
              <TextInput id="wu-mindelay" type="number" min={1} max={3600} value={form.minimumDelaySeconds} onChange={num("minimumDelaySeconds")} />
            </div>
            <div>
              <Label htmlFor="wu-maxdelay">Maximum delay (seconds)</Label>
              <TextInput id="wu-maxdelay" type="number" min={1} max={86400} value={form.maximumDelaySeconds} onChange={num("maximumDelaySeconds")} />
            </div>
            <div>
              <Label htmlFor="wu-winstart">Window start</Label>
              <TextInput id="wu-winstart" type="text" placeholder="09:00" value={form.warmupWindowStart} onChange={(e) => setForm((f) => ({ ...f, warmupWindowStart: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="wu-winend">Window end</Label>
              <TextInput id="wu-winend" type="text" placeholder="17:00" value={form.warmupWindowEnd} onChange={(e) => setForm((f) => ({ ...f, warmupWindowEnd: e.target.value }))} />
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.pauseOnError}
              onChange={(e) => setForm((f) => ({ ...f, pauseOnError: e.target.checked }))}
            />
            Pause automatically after repeated failures (requires manual resume)
          </label>
        </div>

        <div>
          <h4 className="mb-1 text-sm font-semibold text-slate-800">IMAP (for delivery verification)</h4>
          <p className="mb-2 text-xs text-slate-500">
            Optional. Without IMAP, warm-up messages still send but deliveries cannot be
            confirmed — they are recorded as &ldquo;unconfirmed&rdquo; rather than delivered.
            Credentials are encrypted at rest and never returned by the API.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="wu-imaphost">IMAP host</Label>
              <TextInput id="wu-imaphost" placeholder="imap.gmail.com" value={imap.host} onChange={(e) => setImap((v) => ({ ...v, host: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="wu-imapport">IMAP port</Label>
              <TextInput id="wu-imapport" type="number" min={1} max={65535} value={imap.port} onChange={(e) => setImap((v) => ({ ...v, port: Number(e.target.value) }))} />
            </div>
            <div>
              <Label htmlFor="wu-imapsec">IMAP security</Label>
              <Select id="wu-imapsec" value={imap.security} onChange={(e) => setImap((v) => ({ ...v, security: e.target.value }))}>
                <option value="ssl">SSL/TLS (implicit, usually 993)</option>
                <option value="starttls">STARTTLS</option>
                <option value="none">None</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="wu-imapuser">IMAP username (optional)</Label>
              <TextInput id="wu-imapuser" placeholder="Defaults to the SMTP login" value={imap.username} onChange={(e) => setImap((v) => ({ ...v, username: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="wu-imappass">IMAP password (optional)</Label>
              <TextInput id="wu-imappass" type="password" autoComplete="new-password" placeholder="Defaults to the SMTP password" value={imap.password} onChange={(e) => setImap((v) => ({ ...v, password: e.target.value }))} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={testImap} disabled={busy || !imap.host.trim()}>
              Test IMAP
            </Button>
            {testResult ? (
              <span className={`text-sm ${testOk ? "text-emerald-700" : "text-red-700"}`}>{testResult}</span>
            ) : null}
            {mailbox.imapConfigured && !testResult ? (
              <span className="text-xs text-slate-500">
                IMAP is currently configured (host hidden until you type a new one). Status: {mailbox.imapStatus}.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Simple bar chart
// ---------------------------------------------------------------------------

function BarChart({ stats, label }: { stats: WarmupStatsView; label: string }) {
  const max = Math.max(1, ...stats.daily.map((d) => Math.max(d.warmupSent, d.delivered, d.target)));
  return (
    <div>
      <div className="flex items-end gap-1 overflow-x-auto pb-1" role="img" aria-label={`${label} warm-up activity`}>
        {stats.daily.map((d) => (
          <div key={d.date} className="flex min-w-[1.6rem] flex-1 flex-col items-center gap-1">
            <div className="flex h-28 w-full items-end justify-center gap-0.5">
              <div
                className="w-1/2 rounded-t bg-brand-400"
                style={{ height: `${(d.warmupSent / max) * 100}%` }}
                title={`${d.warmupSent} sent`}
              />
              <div
                className="w-1/2 rounded-t bg-emerald-400"
                style={{ height: `${(d.delivered / max) * 100}%` }}
                title={`${d.delivered} confirmed by IMAP`}
              />
            </div>
            <span className="text-[10px] text-slate-500">{d.date.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-brand-400" /> sent
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-400" /> confirmed by IMAP
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function WarmupDashboard({
  initialMailboxes,
  initialStats,
  initialEvents,
}: {
  initialMailboxes: WarmupMailboxView[];
  initialStats: WarmupStatsView;
  initialEvents: WarmupEventView[];
}) {
  const [mailboxes, setMailboxes] = useState(initialMailboxes);
  const [stats, setStats] = useState(initialStats);
  const [events, setEvents] = useState(initialEvents);
  const [editing, setEditing] = useState<WarmupMailboxView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 30>(7);

  const reload = useCallback(async () => {
    const [mb, st, ev] = await Promise.all([
      fetch("/api/warmup/mailboxes", { cache: "no-store" }).then((r) => r.json()),
      fetch(`/api/warmup/stats?days=${range}`, { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/warmup/events?limit=25", { cache: "no-store" }).then((r) => r.json()),
    ]);
    if (mb?.mailboxes) setMailboxes(mb.mailboxes);
    if (st?.stats) setStats(st.stats);
    if (ev?.events) setEvents(ev.events);
  }, [range]);

  async function act(m: WarmupMailboxView, action: "start" | "pause" | "reset") {
    setBusyId(m.smtpAccountId);
    setError(null);
    setNotice(null);
    const r = await post(`/api/warmup/mailboxes/${m.smtpAccountId}/${action}`);
    if (!r.ok) setError(r.error ?? `${action} failed`);
    else setNotice(`${m.email}: ${action} succeeded`);
    await reload();
    setBusyId(null);
  }

  const enrolledCount = mailboxes.filter((m) => m.enrolled).length;

  return (
    <div className="space-y-6">
      <Alert kind="info">
        Warm-up is a controlled sending, ramp and verification mechanism. It does not
        guarantee inbox placement or sender reputation, and completing a ramp never
        increases your campaign send limits. Warm-up messages only ever go to other
        mailboxes you have enrolled — never to an external recipient.
        {enrolledCount > 0 ? ` ${enrolledCount} mailbox(es) enrolled.` : " No mailbox is enrolled yet."}
      </Alert>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total warm-up sends" value={stats.totalSends} />
        <StatCard label="Confirmed by IMAP" value={stats.totalDelivered} />
        <StatCard label="Failed sends" value={stats.totalFailed} />
        <StatCard
          label="Avg delivery latency"
          value={stats.averageLatencyMs === null ? "—" : `${(stats.averageLatencyMs / 1000).toFixed(1)}s`}
        />
        <StatCard label="SMTP failures" value={stats.smtpFailures} />
        <StatCard label="IMAP failures" value={stats.imapFailures} />
        <StatCard label="Unconfirmed" value={stats.totalUnconfirmed} />
        <StatCard label="Consecutive failures" value={stats.consecutiveFailures} />
      </div>

      <Card>
        <CardHeader
          title="Activity"
          description={
            range === 7
              ? "Last 7 days of warm-up sends and IMAP confirmations."
              : "Last 30 days of warm-up sends and IMAP confirmations."
          }
          actions={
            <Select
              value={String(range)}
              onChange={(e) => setRange(Number(e.target.value) as 7 | 30)}
              className="w-32"
              aria-label="Chart range"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </Select>
          }
        />
        <div className="p-6">
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <StatCard label="Current warm-up day" value={stats.currentDay} />
            <StatCard label="Today's target" value={stats.dailyTarget} />
            <StatCard label="Today's usage" value={`${stats.todaySent} sent / ${stats.todayDelivered} confirmed`} />
          </div>
          <BarChart stats={stats} label={range === 7 ? "7-day" : "30-day"} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Mailboxes"
          description="Every connected mailbox. Warm-up is off unless you enable it here."
        />
        <div className="divide-y divide-slate-100">
          {mailboxes.length === 0 ? (
            <EmptyState title="No mailboxes" description="Connect an SMTP mailbox to use warm-up." />
          ) : (
            mailboxes.map((m) => (
              <div key={m.smtpAccountId} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-900">{m.email}</p>
                      {statusBadge(m)}
                      {!m.imapConfigured ? (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          No IMAP — deliveries unconfirmable
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {m.domain} · {m.connectionType.toUpperCase()} {m.host}:{m.port}/{m.security} · SMTP{" "}
                      <StatusBadge status={m.connectionStatus} />
                    </p>
                    {m.statusMessage ? (
                      <p className="mt-1 text-sm text-red-700">{m.statusMessage}</p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" onClick={() => setEditing(m)}>
                      Settings
                    </Button>
                    {m.enabled && m.status === "running" ? (
                      <Button
                        variant="secondary"
                        onClick={() => act(m, "pause")}
                        disabled={busyId === m.smtpAccountId}
                      >
                        Pause
                      </Button>
                    ) : (
                      <Button
                        onClick={() => act(m, "start")}
                        disabled={busyId === m.smtpAccountId}
                      >
                        {m.status === "paused_error" ? "Resume" : "Start"}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => act(m, "reset")}
                      disabled={busyId === m.smtpAccountId || !m.enrolled}
                    >
                      Reset ramp
                    </Button>
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-6">
                  <div>
                    <dt className="text-slate-500">Warm-up day</dt>
                    <dd className="font-semibold text-slate-900">{m.enrolled ? m.currentDay : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Daily target</dt>
                    <dd className="font-semibold text-slate-900">{m.dailyTarget}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Sent today</dt>
                    <dd className="font-semibold text-slate-900">{m.todaySent}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Confirmed today</dt>
                    <dd className="font-semibold text-emerald-700">{m.todayDelivered}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Shared budget left</dt>
                    <dd className="font-semibold text-slate-900">{m.sharedBudgetLeft}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Failed today</dt>
                    <dd className="font-semibold text-red-700">{m.todayFailed}</dd>
                  </div>
                </dl>

                <p className="mt-2 text-xs text-slate-500">
                  Last activity: {fmtDate(m.lastSendAt)} · Successive days:{" "}
                  {m.consecutiveSuccessfulDays} · IMAP: {m.imapConfigured ? m.imapStatus : "not configured"}
                </p>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent activity" description="Audit trail of warm-up events." />
        <div className="p-6">
          {events.length === 0 ? (
            <p className="text-sm text-slate-500">No warm-up events yet.</p>
          ) : (
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                    {e.type}
                  </span>
                  <span className="text-slate-700">{e.message ?? ""}</span>
                  <span className="text-xs text-slate-400">{fmtDate(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <SettingsDialog mailbox={editing} onClose={() => setEditing(null)} onSaved={reload} />
    </div>
  );
}