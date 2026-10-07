"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert, Card, CardHeader } from "@/components/ui";
import {
  SmtpMailboxSelect,
  type SmtpMailboxOption,
} from "@/components/smtp-mailbox-select";

/**
 * Edits a campaign's sending-mailbox selection BEFORE it starts (draft or
 * stopped). Recipients do not exist for drafts; for a stopped campaign the
 * rows that were already sent or attempted keep their frozen mailbox — only
 * the selection used by the NEXT start is replaced here.
 */
export function CampaignSendingMailboxes({
  campaignId,
  mailboxes,
  initialSelected,
}: {
  campaignId: string;
  /** Connected SMTP mailboxes the operator may pick from (server-filtered). */
  mailboxes: SmtpMailboxOption[];
  /** Current selection in position order (from Campaign.sendingAccounts). */
  initialSelected: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Contact count drives the live distribution preview. The preview endpoint
  // resolves the real audience (group or all leads) exactly like the start
  // route does.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/campaigns/${campaignId}/preview`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setLeadCount(typeof d.recipientCount === "number" ? d.recipientCount : null);
      })
      .catch(() => {
        if (!cancelled) setLeadCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const dirty =
    selected.length !== initialSelected.length ||
    selected.some((id, i) => id !== initialSelected[i]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smtpAccountIds: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save mailboxes");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader
        title="Sending mailboxes"
        description="Which connected mailboxes send this campaign. You can change the selection until the campaign starts; each recipient's mailbox (and signature) is frozen at start."
      />
      <div className="space-y-3 px-6 py-4">
        <SmtpMailboxSelect
          mailboxes={mailboxes}
          selected={selected}
          onChange={setSelected}
          leadCount={leadCount}
        />
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy || !dirty || selected.length === 0}>
            {busy ? "Saving…" : "Save mailboxes"}
          </Button>
          {saved ? <span className="text-sm text-emerald-600">Saved</span> : null}
          {selected.length === 0 ? (
            <span className="text-xs text-red-500">Select at least one mailbox.</span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}