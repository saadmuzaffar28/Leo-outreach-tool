import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, CardHeader, StatusBadge, StatCard, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function pct(n: number, d: number) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

export default async function SmsCampaignDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { page?: string; search?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const campaign = await prisma.smsCampaign.findFirst({
    where: { id: params.id, userId: session.sub },
  });
  if (!campaign) {
    return (
      <Card>
        <EmptyState title="Campaign not found" action={<Link href="/sms/campaigns" className="text-brand-600 hover:underline">Back to campaigns</Link>} />
      </Card>
    );
  }

  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);
  const search = (searchParams.search ?? "").trim();

  const where = {
    campaignId: campaign.id,
    ...(search
      ? {
          OR: [
            { phoneNumber: { contains: search } },
            { message: { contains: search, mode: "insensitive" as const } },
            { contact: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [total, messages] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { contact: { select: { name: true } }, replies: { select: { id: true, receivedAt: true } } },
    }),
  ]);

  // Aggregate stats for this campaign.
  const [outbound, replies, optOutContacts] = await Promise.all([
    prisma.message.groupBy({
      by: ["status"],
      where: { campaignId: campaign.id, direction: "outbound" },
      _count: { _all: true },
    }),
    prisma.reply.count({ where: { campaignId: campaign.id } }),
    prisma.contact.count({ where: { userId: session.sub, optOut: true } }),
  ]);

  const bucket: Record<string, number> = {};
  for (const row of outbound) bucket[row.status] = row._count._all;
  const sent = (bucket["sent"] ?? 0) + (bucket["delivered"] ?? 0);
  const delivered = bucket["delivered"] ?? 0;
  const failed =
    (bucket["failed"] ?? 0) + (bucket["undelivered"] ?? 0) + (bucket["rejected"] ?? 0);
  const recipients = outbound.reduce((a, r) => a + r._count._all, 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title={campaign.name}
        description={`Created ${campaign.createdAt.toLocaleString()}`}
        actions={<Link href="/sms/campaigns" className="text-sm font-medium text-brand-600 hover:underline">← All campaigns</Link>}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-xs font-semibold uppercase text-slate-400">Message</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{campaign.message}</p>
        </Card>
        <Card className="p-5">
          <h3 className="text-xs font-semibold uppercase text-slate-400">Details</h3>
          <dl className="mt-2 space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd><StatusBadge status={campaign.status} /></dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Sender</dt><dd className="font-medium">{campaign.source}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Send date</dt><dd className="font-medium">{(campaign.scheduledAt ?? campaign.completedAt ?? campaign.createdAt).toLocaleString()}</dd></div>
            {campaign.completedAt ? (
              <div className="flex justify-between"><dt className="text-slate-500">Completed</dt><dd className="font-medium">{campaign.completedAt.toLocaleString()}</dd></div>
            ) : null}
            {campaign.x8BatchId ? (
              <div className="flex justify-between"><dt className="text-slate-500">8x8 batch</dt><dd className="font-mono text-xs">{campaign.x8BatchId.slice(0, 18)}…</dd></div>
            ) : null}
          </dl>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
        <StatCard label="Recipients" value={recipients} />
        <StatCard label="Sent" value={sent} />
        <StatCard label="Delivered" value={delivered} />
        <StatCard label="Failed" value={failed} />
        <StatCard label="Replies" value={replies} />
        <StatCard label="Delivery rate" value={`${pct(delivered, sent)}%`} accent />
        <StatCard label="Reply rate" value={`${pct(replies, sent)}%`} />
      </div>
      <p className="mt-2 text-xs text-slate-400">Opt-outs across all campaigns: {optOutContacts}</p>

      {/* Message activity */}
      <div className="mt-8">
        <Card>
          <CardHeader
            title="Message activity"
            description={`${total} messages`}
            actions={
              <form method="get" className="flex gap-2">
                <input type="search" name="search" defaultValue={search} placeholder="Search name / number / text…"
                  className="w-56 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
                <button className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Search</button>
              </form>
            }
          />
          {messages.length === 0 ? (
            <EmptyState title="No messages found" description={search ? "Try a different search." : "This campaign has no messages yet."} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-6 py-3">Contact</th>
                      <th className="px-4 py-3">Phone number</th>
                      <th className="px-4 py-3">Message</th>
                      <th className="px-4 py-3">Direction</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Sent</th>
                      <th className="px-4 py-3">Delivered</th>
                      <th className="px-4 py-3">Replied</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {messages.map((m) => (
                      <tr key={m.id} className="hover:bg-slate-50">
                        <td className="px-6 py-3 font-medium text-slate-900">{m.contact?.name ?? "—"}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600">{m.phoneNumber}</td>
                        <td className="max-w-[22rem] truncate px-4 py-3 text-slate-600" title={m.message}>{m.message}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.direction === "inbound" ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-600"}`}>
                            {m.direction}
                          </span>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={m.status} /></td>
                        <td className="px-4 py-3 text-slate-500">{m.sentAt?.toLocaleString() ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-500">{m.deliveredAt?.toLocaleString() ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-500">
                          {m.replies.length > 0 ? m.replies[0].receivedAt.toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 ? (
                <div className="flex items-center justify-between border-t border-slate-100 px-6 py-3 text-sm">
                  <span className="text-slate-500">Page {page} of {totalPages}</span>
                  <div className="flex gap-2">
                    {page > 1 ? (
                      <Link href={`/sms/campaigns/${campaign.id}?page=${page - 1}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50">Previous</Link>
                    ) : null}
                    {page < totalPages ? (
                      <Link href={`/sms/campaigns/${campaign.id}?page=${page + 1}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50">Next</Link>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
