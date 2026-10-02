import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDashboardStats, getSendDashboard } from "@/lib/stats";
import { PageHeader, StatCard, Card, CardHeader, StatusBadge, ButtonLink, EmptyState, Alert } from "@/components/ui";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const stats = await getDashboardStats(session.sub);
  const send = await getSendDashboard(session.sub);

  const todaySent = send.usage.reduce((a, u) => a + u.messagesSent, 0);
  const anyQuotaPaused = send.usage.some((u) => u.quotaPaused);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Overview of your outreach program"
        actions={<ButtonLink href="/campaigns/new">New campaign</ButtonLink>}
      />

      {send.settings.sendMode === "test" ? (
        <div className="mb-6"><Alert kind="error">TEST MODE is ON — the worker simulates sends and never calls Gmail. Switch to “live” in Settings to send real email.</Alert></div>
      ) : null}

      {anyQuotaPaused ? (
        <div className="mb-6"><Alert kind="info">A connected account is temporarily paused by Gmail rate limiting. The worker is retrying automatically.</Alert></div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Gmail accounts" value={stats.accountCount} />
        <StatCard label="Leads" value={stats.leadCount} />
        <StatCard label="Active campaigns" value={stats.activeCampaigns} accent />
        <StatCard label="Emails sent" value={stats.emailsSent} />
        <StatCard label="Pending" value={stats.emailsPending} />
        <StatCard label="Suppressed" value={stats.suppressed} />
      </div>

      <div className="mt-8">
        <Card>
          <CardHeader
            title="Sending limits"
            description="Today's application sends vs the configured daily limit"
            actions={
              <Link href="/settings" className="text-sm font-medium text-brand-600 hover:underline">
                Change limits
              </Link>
            }
          />
          <div className="px-6 py-4">
            {send.usage.length === 0 ? (
              <p className="text-sm text-slate-500">Connect a Gmail account in Settings to enable sending.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-6 py-3">Account</th>
                      <th className="px-4 py-3 text-right">Sent today</th>
                      <th className="px-4 py-3 text-right">Limit</th>
                      <th className="px-4 py-3 text-right">Remaining</th>
                      <th className="px-4 py-3 text-right">Failed</th>
                      <th className="px-6 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {send.usage.map((u) => {
                      const remaining = send.settings.dailySendLimit - u.messagesSent;
                      return (
                        <tr key={u.accountId} className="hover:bg-slate-50">
                          <td className="px-6 py-3 font-medium text-slate-900">{u.email}</td>
                          <td className="px-4 py-3 text-right text-slate-600">{u.messagesSent}</td>
                          <td className="px-4 py-3 text-right text-slate-600">{send.settings.dailySendLimit}</td>
                          <td className={`px-4 py-3 text-right ${remaining > 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {Math.max(0, remaining)}
                          </td>
                          <td className="px-4 py-3 text-right text-red-600">{u.messagesFailed}</td>
                          <td className="px-6 py-3">
                            {u.quotaPaused ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                Rate-limited — retrying automatically
                                {u.quotaPausedUntil ? ` until ${u.quotaPausedUntil.toLocaleTimeString()}` : ""}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                Sending normally
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-4 px-6 text-xs text-slate-400">
              <span>Effective rate: ~{send.settings.effectivePerMinute}/min per account</span>
              <span>Minimum delay: {send.settings.minDelaySeconds}s</span>
              <span>Max retries: {send.settings.maxRetryAttempts}</span>
              <span>Today combined: {todaySent} / {send.usage.length * send.settings.dailySendLimit}</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-8">
        <Card>
          <CardHeader title="Campaign performance" description="Recent campaigns" />
          {stats.campaigns.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              description="Create your first campaign to start sending outreach."
              action={<ButtonLink href="/campaigns/new">Create campaign</ButtonLink>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-6 py-3">Campaign</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-right">Sent</th>
                    <th className="px-4 py-3 text-right">Failed</th>
                    <th className="px-4 py-3 text-right">Skipped</th>
                    <th className="px-4 py-3 text-right">Remaining</th>
                    <th className="px-6 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {stats.campaigns.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-6 py-3 font-medium text-slate-900">{c.name}</td>
                      <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                      <td className="px-4 py-3 text-right text-slate-600">{c.total}</td>
                      <td className="px-4 py-3 text-right text-emerald-600">{c.sent}</td>
                      <td className="px-4 py-3 text-right text-red-600">{c.failed}</td>
                      <td className="px-4 py-3 text-right text-slate-500">{c.skipped}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{c.remaining}</td>
                      <td className="px-6 py-3 text-right">
                        <Link href={`/campaigns/${c.id}`} className="font-medium text-brand-600 hover:underline">
                          View
                        </Link>
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