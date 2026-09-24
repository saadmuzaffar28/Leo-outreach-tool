import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession, isOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, CardHeader, StatusBadge, ButtonLink, EmptyState, Alert } from "@/components/ui";
import { CampaignActions } from "@/components/campaign-actions";
import { getSendSettings } from "@/lib/settings";
import { campaignTemplateName } from "@/lib/templates";
import type { RecipientStatus } from "@/lib/campaigns";

const KEYS: RecipientStatus[] = ["pending", "sending", "sent", "failed", "skipped"];

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    include: { template: true, googleAccount: true, microsoftAccount: true, smtpAccount: true },
  });
  if (!campaign || !isOwner(session, campaign.userId)) notFound();

  const [counts, recipients, settings] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    }),
    prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: "asc" },
      include: { lead: { select: { firstName: true, lastName: true, practiceName: true } } },
    }),
    getSendSettings(session.sub),
  ]);

  const stats = KEYS.reduce<Record<string, number>>((acc, k) => {
    acc[k] = counts.find((r) => r.status === k)?._count._all ?? 0;
    return acc;
  }, {});

  const workerNeeded =
    campaign.status === "active" &&
    (stats["pending"] + stats["sending"] > 0);

  return (
    <div>
      <PageHeader
        title={campaign.name}
        description={`Created ${campaign.createdAt.toLocaleDateString()}`}
        actions={<ButtonLink href="/campaigns" variant="secondary">← All campaigns</ButtonLink>}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={campaign.status} />
        <span className="text-sm text-slate-500">
          From: <span className="font-medium text-slate-700">{campaign.googleAccount?.googleEmail ?? campaign.microsoftAccount?.microsoftEmail ?? campaign.smtpAccount?.email ?? "No account"}</span>
          {campaign.smtpAccount ? " (SMTP)" : campaign.microsoftAccount ? " (Outlook)" : campaign.googleAccount ? " (Gmail)" : null}
        </span>
        <span className="text-sm text-slate-500">
          Template:{" "}
          {campaign.template ? (
            <Link href={`/templates/${campaign.templateId}`} className="font-medium text-brand-600 hover:underline">
              {campaignTemplateName(campaign)}
            </Link>
          ) : (
            <span className="font-medium text-slate-700">{campaignTemplateName(campaign) ?? "None"}</span>
          )}
          {campaign.templateSnapshot ? (
            <span className="text-xs text-slate-400"> (snapshot saved at start)</span>
          ) : null}
        </span>
      </div>

      {settings.sendMode === "test" ? (
        <div className="mb-6"><Alert kind="error">TEST MODE is ON — the worker simulates sends for this campaign and never calls the email provider.</Alert></div>
      ) : null}

      {campaign.pausedReason && campaign.status === "paused" ? (
        <div className="mb-6"><Alert kind="info">{campaign.pausedReason}</Alert></div>
      ) : null}

      {workerNeeded ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This campaign is active and queued for sending. Start the send worker with{" "}
          <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">npm run worker</code>{" "}
          to begin delivery.
        </div>
      ) : null}

      <Card className="mb-6">
        <CardHeader title="Campaign control" description="Start, pause, resume or stop the campaign" />
        <div className="px-6 py-4">
          <CampaignActions campaignId={campaign.id} status={campaign.status} />
        </div>
      </Card>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
        <Card className="p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{KEYS.reduce((a, k) => a + stats[k], 0)}</p>
          <p className="text-xs text-slate-500">Recipients</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-2xl font-bold text-emerald-600">{stats.sent}</p>
          <p className="text-xs text-slate-500">Sent</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-2xl font-bold text-red-600">{stats.failed}</p>
          <p className="text-xs text-slate-500">Failed</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-2xl font-bold text-slate-500">{stats.skipped}</p>
          <p className="text-xs text-slate-500">Skipped</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-2xl font-bold text-slate-600">{stats.pending + stats.sending}</p>
          <p className="text-xs text-slate-500">Remaining</p>
        </Card>
      </div>

      <Card>
        <CardHeader title="Message log" description="Per-recipient send status" />
        {recipients.length === 0 ? (
          <EmptyState
            title="No recipients yet"
            description="Start the campaign to build the recipient list from your leads."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-6 py-3">Recipient</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Attempts</th>
                  <th className="px-4 py-3">Last error</th>
                  <th className="px-4 py-3">Sent at</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recipients.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 text-slate-600">{r.recipient}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {r.lead
                        ? `${r.lead.firstName} ${r.lead.lastName ?? ""}`.trim()
                        : "—"}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 text-slate-500">{r.attempts}</td>
                    <td className="px-4 py-3">
                      <span className="block max-w-[240px] truncate text-xs text-slate-500" title={r.lastError ?? ""}>
                        {r.lastError ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {r.sentAt ? r.sentAt.toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}