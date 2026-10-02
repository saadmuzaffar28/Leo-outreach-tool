"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Detaches one contact from a group. The contact itself is NOT deleted - it
 * remains in All Contacts and in any other group it belongs to.
 */
export function RemoveFromGroupButton({
  groupId,
  leadId,
  email,
}: {
  groupId: string;
  leadId: string;
  email: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (
      !confirm(
        `Remove ${email} from this group?\n\nThe contact itself is kept in All Contacts.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/leads`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Remove failed");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      className="rounded-md px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
    >
      Remove
    </button>
  );
}
