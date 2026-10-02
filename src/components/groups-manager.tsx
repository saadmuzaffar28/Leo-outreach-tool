"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput, TextArea, Label, Alert, EmptyState, Card } from "@/components/ui";
import { Modal } from "@/components/modal";

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
}

export function GroupsManager({
  initialGroups,
  onChanged,
}: {
  initialGroups: GroupRow[];
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupRow[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [renameTarget, setRenameTarget] = useState<GroupRow | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameDescription, setRenameDescription] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);

  function refresh() {
    setGroups(initialGroups);
    router.refresh();
    onChanged?.();
  }

  async function call(url: string, method: string, payload?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      return data;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    const data = await call("/api/groups", "POST", { name, description });
    if (!data) return;
    setCreateOpen(false);
    setName("");
    setDescription("");
    refresh();
  }

  async function saveRename() {
    if (!renameTarget) return;
    const data = await call(`/api/groups/${renameTarget.id}`, "PATCH", {
      name: renameName,
      description: renameDescription,
    });
    if (!data) return;
    setRenameTarget(null);
    refresh();
  }

  async function deleteGroup() {
    if (!deleteTarget) return;
    const data = await call(`/api/groups/${deleteTarget.id}`, "DELETE");
    if (!data) return;
    setDeleteTarget(null);
    refresh();
  }

  const totalContacts = useMemo(
    () => groups.reduce((sum, g) => sum + g.contactCount, 0),
    [groups],
  );

  return (
    <div className="space-y-4">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Card>
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Groups</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              {groups.length} group{groups.length === 1 ? "" : "s"} · {totalContacts} membership
              {totalContacts === 1 ? "" : "s"} · {initialGroups.length > 0 ? "" : "no groups yet"}
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>+ Create Group</Button>
        </div>

        {groups.length === 0 ? (
          <EmptyState
            title="No groups yet"
            description="Create a group to organise contacts, then import a CSV into it or send a campaign to just that group."
            action={<Button onClick={() => setCreateOpen(true)}>+ Create Group</Button>}
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {groups.map((g) => (
              <li
                key={g.id}
                className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{g.name}</p>
                  {g.description ? (
                    <p className="truncate text-sm text-slate-500">{g.description}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    {g.contactCount} contact{g.contactCount === 1 ? "" : "s"}
                  </span>
                  <a
                    href={`/leads?tab=email&group=${encodeURIComponent(g.id)}`}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View contacts
                  </a>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRenameTarget(g);
                      setRenameName(g.name);
                      setRenameDescription(g.description ?? "");
                    }}
                  >
                    Rename
                  </Button>
                  <Button variant="danger" onClick={() => setDeleteTarget(g)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---------------------------------------------------------- create */}
      <Modal
        title="Create Group"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createGroup} disabled={busy || name.trim().length === 0}>
              {busy ? "Creating…" : "Create Group"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="new-group-name">Group Name</Label>
            <TextInput
              id="new-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Healthcare Prospects"
              maxLength={120}
            />
          </div>
          <div>
            <Label htmlFor="new-group-desc">Description (optional)</Label>
            <TextArea
              id="new-group-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this group is for"
              maxLength={500}
            />
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- rename */}
      <Modal
        title="Rename group"
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button onClick={saveRename} disabled={busy || renameName.trim().length === 0}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="rename-group-name">Group Name</Label>
            <TextInput
              id="rename-group-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              maxLength={120}
            />
          </div>
          <div>
            <Label htmlFor="rename-group-desc">Description (optional)</Label>
            <TextArea
              id="rename-group-desc"
              rows={3}
              value={renameDescription}
              onChange={(e) => setRenameDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          <Alert kind="info">
            Campaigns already using this group keep pointing at it, so renaming never changes
            who they were addressed to.
          </Alert>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- delete */}
      <Modal
        title="Delete group"
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={deleteGroup} disabled={busy}>
              {busy ? "Deleting…" : "Delete group"}
            </Button>
          </>
        }
      >
        {deleteTarget ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Delete <span className="font-semibold text-slate-900">{deleteTarget.name}</span>?
            </p>
            <Alert kind="info">
              {deleteTarget.contactCount} contact
              {deleteTarget.contactCount === 1 ? "" : "s"} will be{" "}
              <span className="font-semibold">kept</span>. Only the group and its membership are
              removed — every contact stays in All Contacts.
            </Alert>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
