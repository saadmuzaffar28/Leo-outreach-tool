import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSmsKpis, getSmsCampaignRows, getMessagesOverTime } from "@/lib/sms-stats";
import { ensureSmsMockData } from "@/lib/sms-mock";
import { PageHeader, StatCard, Card, CardHeader, StatusBadge, ButtonLink, EmptyState } from "@/components/ui";
import { DemoModeBanner } from "@/components/sms/demo-banner";
import { LineChart, HBarList } from "@/components/sms/charts";

export const dynamic = "force-dynamic";

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function SmsDashboardPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; campaign?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  // Demo mode: seed realistic mock data on first visit when 8x8 is not configured.
  await ensureSmsMockData(session.sub);

  const from = parseDate(searchParams.from);
  const to = parseDate(searchParams.to);
  const campaignId = searchParams.campaign || undefined;

  const [kpis, campaigns, series] = await Promise.all([
    getSmsKpis(session.sub, { from, to, campaignId }),
    getSmsCampaignRows(session.sub),
    getMessagesOverTime(session.sub, 30, campaignId),
  ]);

  const selectedCampaign = campaignId
    ? await prisma.smsCampaign.findFirst({ where: { id: campaignId, userId: session.sub } })
    : null;

  const replyRateByCampaign = campaigns
    .filter((c) => c.sent > 0)
    .slice(0, 8)
    .map((c) => ({ label: c.name, value: c.replyRate }));

  return (
    <div>
      <PageHeader
        title="SMS Dashboard"
        description="Overview of your 8x8 SMS messaging"
        actions={<ButtonLink href="/sms/campaigns/new">New campaign</ButtonLink>}
      />

      <DemoModeBanner />

      {/* Filters */}
      <Card className="mb-6 p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="from" className="mb-1 block text-xs font-medium text-slate-500">From</label>
            <input id="from" name="from" type="date" defaultValue={searchParams.from ?? ""}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="to" className="mb-1 block text-xs font-medium text-slate-500">To</label>
            <input id="to" name="to" type="date" defaultValue={searchParams.to ?? ""}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="campaign" className="mb-1 block text-xs font-medium text-slate-500">Campaign</label>
            <select id="campaign" name="campaign" defaultValue={campaignId ?? ""}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none">
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            Apply filters
          </button>
          <a href="/sms" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            Reset
          </a>
          {selectedCampaign ? (
            <span className="ml-auto rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
              Filtered: {selectedCampaign.name}
            </span>
          ) : null}
        </form>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total messages sent" value={kpis.totalSent} />
        <StatCard label="Delivered" value={kpis.delivered} />
        <StatCard label="Delivery rate" value={`${kpis.deliveryRate}%`} accent />
        <StatCard label="Failed" value={kpis.failed} />
        <StatCard label="Replies" value={kpis.replies} />
        <StatCard label="Reply rate" value={`${kpis.replyRate}%`} />
        <StatCard label="Opt-outs" value={kpis.optOuts} />
        <StatCard label="Opt-out rate" value={`${kpis.optOutRate}%`} />
      </div>

      {/* Charts */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Messages sent over time" description="Last 30 days" />
          <div className="px-4 py-4">
            <LineChart data={series.map((p) => ({ label: p.date.slice(5), value: p.sent }))} ariaLabel="Messages sent per day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Replies over time" description="Inbound replies per day" />
          <div className="px-4 py-4">
            <LineChart data={series.map((p) => ({ label: p.date.slice(5), value: p.replies }))} color="#0ea5e9" ariaLabel="Replies per day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Delivery vs failures" description="Daily delivered and failed messages" />
          <div className="px-4 py-4">
            <LineChart data={series.map((p) => ({ label: p.date.slice(5), value: p.delivered }))} color="#10b981" ariaLabel="Delivered per day" />
            <LineChart data={series.map((p) => ({ label: p.date.slice(5), value: p.failed }))} color="#ef4444" ariaLabel="Failed per day" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Reply rate by campaign" description="Top campaigns by replies received" />
          <div className="px-6 py-5">
            {replyRateByCampaign.length === 0 ? (
              <EmptyState title="No campaign data yet" description="Send a campaign to see reply rates." />
            ) : (
              <HBarList data={replyRateByCampaign} color="#0ea5e9" />
            )}
          </div>
        </Card>
      </div>

      {/* Campaign table */}
      <div className="mt-8">
        <Card>
          <CardHeader
            title="Campaigns"
            description="Recent SMS campaigns"
            actions={<ButtonLink href="/sms/campaigns" variant="secondary">View all</ButtonLink>}
          />
          {campaigns.length === 0 ? (
            <EmptyState
              title="No SMS campaigns yet"
              description="Create your first SMS campaign to reach your contacts."
              action={<ButtonLink href="/sms/campaigns/new">Create campaign</ButtonLink>}
            />
          ) : (
            <div className="overflow-x-auto">
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
                  {campaigns.slice(0, 10).map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-6 py-3 font-medium text-slate-900">{c.name}</td>
                      <td className="px-4 py-3 text-slate-500">{c.createdAt.toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{c.audience}</td>
                      <td className="px-4 py-3 text-right text-emerald-600">{c.sent}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{c.delivered}</td>
                      <td className="px-4 py-3 text-right text-red-600">{c.failed}</td>
                      <td className="px-4 py-3 text-right text-sky-600">{c.replies}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{c.replyRate}%</td>
                      <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                      <td className="px-6 py-3 text-right">
                        <a href={`/sms/campaigns/${c.id}`} className="font-medium text-brand-600 hover:underline">View</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
