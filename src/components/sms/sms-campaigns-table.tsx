import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import type { getSmsCampaignRows } from "@/lib/sms-stats";

type SmsCampaignRow = Awaited<ReturnType<typeof getSmsCampaignRows>>[number];

export function SmsCampaignsTable({ campaigns }: { campaigns: SmsCampaignRow[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400 shadow-sm">
        No SMS campaigns yet. Create one to start messaging your contacts.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-6 py-3">Campaign</th>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3 text-right">Audience</th>
            <th className="px-4 py-3 text-right">Sent</th>
            <th className="px-4 py-3 text-right">Delivered</th>
            <th className="px-4 py-3 text-right">Failed</th>
            <th className="px-4 py-3 text-right">Replies</th>
            <th className="px-4 py-3 text-right">Reply rate</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-6 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {campaigns.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50">
              <td className="px-6 py-3 font-medium text-slate-900">
                <Link href={`/sms/campaigns/${c.id}`} className="hover:text-brand-700">{c.name}</Link>
              </td>
              <td className="px-4 py-3 text-slate-500">{c.createdAt.toLocaleDateString()}</td>
              <td className="px-4 py-3 text-right text-slate-600">{c.audience}</td>
              <td className="px-4 py-3 text-right text-emerald-600">{c.sent}</td>
              <td className="px-4 py-3 text-right text-slate-600">{c.delivered}</td>
              <td className="px-4 py-3 text-right text-red-600">{c.failed}</td>
              <td className="px-4 py-3 text-right text-sky-600">{c.replies}</td>
              <td className="px-4 py-3 text-right text-slate-600">{c.replyRate}%</td>
              <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
              <td className="px-6 py-3 text-right">
                <Link href={`/sms/campaigns/${c.id}`} className="font-medium text-brand-600 hover:underline">View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
