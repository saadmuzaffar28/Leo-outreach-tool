"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

export function DisconnectOutlookButton({ accountId, email }: { accountId: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    if (!confirm(`Disconnect ${email}? Your Outlook tokens will be deleted and campaigns using it will no longer send.`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/microsoft/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: accountId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Disconnect failed");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="danger" onClick={disconnect} disabled={busy}>
      {busy ? "Disconnecting…" : "Disconnect"}
    </Button>
  );
}