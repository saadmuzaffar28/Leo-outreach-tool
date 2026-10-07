"use client";

import { distributionCounts } from "@/lib/campaign-distribution";

export interface SmtpMailboxOption {
  id: string;
  email: string;
  /** Per-mailbox sender name; when absent the selector just shows the address. */
  displayName?: string | null;
}

/**
 * Multi-mailbox selection for a campaign: checkbox list of the operator's
 * connected SMTP mailboxes, a "Selected: N mailboxes" counter, and a LIVE
 * distribution preview (contacts ÷ mailboxes, balanced) computed client-side
 * with the exact same deterministic helper the campaign-start route uses.
 *
 * The parent decides which mailboxes are shown (eligible = connected only) and
 * owns the selection state; `onChange` fires with the full next selection in
 * click order, which is the selection order persisted to the campaign.
 */
export function SmtpMailboxSelect({
  mailboxes,
  selected,
  onChange,
  leadCount,
  disabled = false,
}: {
  mailboxes: SmtpMailboxOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Target contact count; when present (> 0) renders the distribution preview. */
  leadCount?: number | null;
  disabled?: boolean;
}) {
  const emailById = new Map(mailboxes.map((m) => [m.id, m.email]));
  const counts =
    leadCount != null && leadCount > 0 && selected.length > 0
      ? distributionCounts(leadCount, selected)
      : null;

  function toggle(id: string) {
    if (disabled) return;
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {mailboxes.map((m) => {
          const checked = selected.includes(m.id);
          return (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm transition-colors hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(m.id)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="font-medium text-slate-700">
                {m.displayName ? `${m.displayName} — ${m.email}` : m.email}
              </span>
              <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                Connected
              </span>
            </label>
          );
        })}
      </div>

      <p className="text-xs text-slate-500">
        Selected:{" "}
        <span className="font-semibold text-slate-700">{selected.length}</span>{" "}
        {selected.length === 1 ? "mailbox" : "mailboxes"}
      </p>

      {counts ? (
        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm">
          <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">
            Distribution · {leadCount} {leadCount === 1 ? "contact" : "contacts"} across{" "}
            {counts.length} {counts.length === 1 ? "mailbox" : "mailboxes"}
          </p>
          <ul className="space-y-1">
            {counts.map((c) => (
              <li
                key={c.smtpAccountId}
                className="flex items-center justify-between gap-3 text-slate-600"
              >
                <span className="truncate">
                  {emailById.get(c.smtpAccountId) ?? c.smtpAccountId}
                </span>
                <span className="font-semibold text-slate-900">
                  {c.count} {c.count === 1 ? "contact" : "contacts"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            Balanced: no mailbox differs from another by more than 1. The exact
            assignment is frozen when the campaign starts.
          </p>
        </div>
      ) : null}
    </div>
  );
}