import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSmsKpis, getSmsCampaignRows, getMessagesOverTime } from "@/lib/sms-stats";
import { PageHeader, Card, CardHeader, StatCard } from "@/components/ui";
import { DemoModeBanner } from "@/components/sms/demo-banner";
import { BarChart, LineChart, HBarList } from "@/components/sms/charts";

export const dynamic = "force-dynamic";

export default async function SmsAnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [kpis, campaigns, series] = await Promise.all([
    getSmsKpis(session.sub),
    getSmsCampaignRows(session.sub),
    getMessagesOverTime(session.sub, 30),
  ]);

  // Messages by hour (0-23) over the last 30 days.
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const recentMessages = await prisma.message.findMany({
    where: { userId: session.sub, direction: "outbound", createdAt: { gte: since } },
    select: { createdAt: true, status: true },
  });
  const byHour = Array.from({ length: 24 }, (_, h) => ({ label: String(h), value: 0 }));
  for (const m of recentMessages) byHour[m.createdAt.getHours()].value += 1;

  const ranked = campaigns.filter((c) => c.sent > 0).sort((a, b) => b.replyRate - a.replyRate);
  const best = ranked.slice(0, 5);
  const worst = [...ranked].reverse().slice(0, 5);

  return (
    <div>
      <PageHeader title="SMS Analytics" description="Delivery and engagement insights" />
      <DemoModeBanner />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Overall delivery rate" value={`${kpis.deliveryRate}%`} accent />
        <StatCard label="Overall reply rate" value={`${kpis.replyRate}%`} />
        <StatCard label="Overall opt-out rate" value={`${kpis.optOutRate}%`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Messages by day" description="Outbound messages, last 30 days" />
          <div className="px-4 py-4">
            <BarChart data={series.map((p) => ({ label: p.date.slice(5), value: p.sent }))} ariaLabel="Messages per day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Replies by day" description="Inbound replies, last 30 days" />
          <div className="px-4 py-4">
            <BarChart data={series.map((p) => ({ label: p.date.slice(5), value: p.replies }))} color="#0ea5e9" ariaLabel="Replies per day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Messages by hour" description="Send-time distribution (local time)" />
          <div className="px-4 py-4">
            <BarChart data={byHour} color="#8b5cf6" ariaLabel="Messages by hour of day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Delivery failures" description="Failed / undelivered / rejected per day" />
          <div className="px-4 py-4">
            <LineChart data={series.map((p) => ({ label: p.date.slice(5), value: p.failed }))} color="#ef4444" ariaLabel="Failures per day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Best-performing campaigns" description="Highest reply rates" />
          <div className="px-6 py-5">
            {best.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No campaign data yet</p>
            ) : (
              <HBarList data={best.map((c) => ({ label: c.name, value: c.replyRate }))} color="#10b981" />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Worst-performing campaigns" description="Lowest reply rates" />
          <div className="px-6 py-5">
            {worst.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No campaign data yet</p>
            ) : (
              <HBarList data={worst.map((c) => ({ label: c.name, value: c.replyRate }))} color="#ef4444" />
            )}
          </div>
        </Card>
      </div>

      {/* Campaign comparison table */}
      <div className="mt-6">
        <Card>
          <CardHeader title="Campaign comparison" description="All campaigns side by side" />
          {campaigns.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-slate-400">No campaigns yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-6 py-3">Campaign</th>
                    <th className="px-4 py-3 text-right">Sent</th>
                    <th className="px-4 py-3 text-right">Delivered</th>
                    <th className="px-4 py-3 text-right">Delivery rate</th>
                    <th className="px-4 py-3 text-right">Replies</th>
                    <th className="px-4 py-3 text-right">Reply rate</th>
                    <th className="px-6 py-3 text-right">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {campaigns.map((c) => {
                    const deliveryRate = c.sent > 0 ? Math.round((c.delivered / c.sent) * 1000) / 10 : 0;
                    return (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="px-6 py-3 font-medium text-slate-900">{c.name}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{c.sent}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{c.delivered}</td>
                        <td className="px-4 py-3 text-right font-medium text-emerald-600">{deliveryRate}%</td>
                        <td className="px-4 py-3 text-right text-slate-600">{c.replies}</td>
                        <td className="px-4 py-3 text-right font-medium text-sky-600">{c.replyRate}%</td>
                        <td className="px-6 py-3 text-right text-red-600">{c.failed}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
