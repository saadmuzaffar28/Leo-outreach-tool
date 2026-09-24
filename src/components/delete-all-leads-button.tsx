"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

export function DeleteAllLeadsButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (count === 0) return;
    if (!confirm(`Delete ALL ${count} leads? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/leads", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Delete failed");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="danger" onClick={remove} disabled={busy || count === 0}>
      {busy ? "Deleting…" : count > 0 ? `Delete all leads (${count})` : "Delete all leads"}
    </Button>
  );
}