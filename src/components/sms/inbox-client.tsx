"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, TextInput, TextArea } from "@/components/ui";
import { useToast } from "@/components/sms/toast";

interface Conversation {
  phoneNumber: string;
  contactName: string | null;
  campaignName: string | null;
  lastMessage: string;
  lastDirection: string;
  lastAt: string;
}

interface ThreadMessage {
  id: string;
  direction: string;
  message: string;
  status: string;
  createdAt: string;
}

export function InboxClient() {
  const toast = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/sms/inbox");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { conversations: Conversation[] };
      setConversations(data.conversations);
    } catch {
      toast.push("Failed to load inbox", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadThread = useCallback(async (phoneNumber: string) => {
    try {
      const res = await fetch(`/api/sms/inbox?phoneNumber=${encodeURIComponent(phoneNumber)}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { messages: ThreadMessage[] };
      setThread(data.messages);
    } catch {
      toast.push("Failed to load conversation", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (active) loadThread(active);
  }, [active, loadThread]);

  async function sendReply() {
    if (!active || !reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/sms/inbox/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: active, message: reply.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to send reply");
      toast.push("Reply sent", "success");
      setReply("");
      await loadThread(active);
      await loadConversations();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Send failed", "error");
    } finally {
      setSending(false);
    }
  }

  const filtered = conversations.filter(
    (c) =>
      !search ||
      c.phoneNumber.includes(search) ||
      (c.contactName ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      {/* Conversation list */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-3">
          <TextInput placeholder="Search conversations…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="max-h-[32rem] divide-y divide-slate-100 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">No conversations yet</p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.phoneNumber}
                onClick={() => setActive(c.phoneNumber)}
                className={`block w-full px-4 py-3 text-left hover:bg-slate-50 ${active === c.phoneNumber ? "bg-brand-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900">{c.contactName ?? c.phoneNumber}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(c.lastAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {c.lastDirection === "inbound" ? "↩ " : ""}{c.lastMessage}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Thread */}
      <div className="flex min-h-[32rem] flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
        {!active ? (
          <div className="flex flex-1 items-center justify-center p-10 text-center">
            <p className="text-sm text-slate-400">Select a conversation to view the history and reply.</p>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="font-semibold text-slate-900">{active}</h3>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {thread.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">No messages in this thread yet.</p>
              ) : (
                thread.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-md rounded-2xl px-4 py-2.5 text-sm ${
                        m.direction === "outbound"
                          ? "rounded-tr-sm bg-brand-600 text-white"
                          : "rounded-tl-sm bg-slate-100 text-slate-800"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.message}</p>
                      <p className={`mt-1 text-[10px] ${m.direction === "outbound" ? "text-brand-200" : "text-slate-400"}`}>
                        {new Date(m.createdAt).toLocaleString()} · {m.status}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-slate-100 p-4">
              <TextArea rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
                placeholder="Type your reply…" maxLength={1600} />
              <div className="mt-2 flex justify-end">
                <Button onClick={sendReply} disabled={sending || !reply.trim()}>
                  {sending ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
