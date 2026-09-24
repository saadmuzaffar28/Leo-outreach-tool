import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, StatusBadge, ButtonLink, EmptyState } from "@/components/ui";
import { SectionTabs } from "@/components/section-tabs";
import { SmsCampaignsTable } from "@/components/sms/sms-campaigns-table";
import { DemoModeBanner } from "@/components/sms/demo-banner";
import { DeleteCampaignButton } from "@/components/delete-campaign-button";
import { campaignTemplateName } from "@/lib/templates";
import type { RecipientStatus } from "@/lib/campaigns";
import { getSmsCampaignRows } from "@/lib/sms-stats";

const KEYS: RecipientStatus[] = ["pending", "sending", "sent", "failed", "skipped"];

type SearchParams = {
  tab?: string;
};

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const tab = searchParams.tab === "email" ? "email" : "sms";

  if (tab === "sms") {
    const smsCampaigns = await getSmsCampaignRows(session.sub);
    return (
      <div>
        <PageHeader
          title="Campaigns"
          description="Create and manage SMS and email outreach campaigns"
        />
        <SectionTabs
          baseUrl="/campaigns"
          tabs={[
            { key: "sms", label: "SMS Campaigns" },
            { key: "email", label: "Email Campaigns" },
          ]}
          active={tab}
        />
        <DemoModeBanner />
        <div className="mb-4">
          <ButtonLink href="/sms/campaigns/new">New SMS campaign</ButtonLink>
        </div>
        <SmsCampaignsTable campaigns={smsCampaigns} />
      </div>
    );
  }

  const campaigns = await prisma.campaign.findMany({
    where: { userId: session.sub },
    orderBy: { updatedAt: "desc" },
    include: { template: true },
  });

  const counts = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });
  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const bucket = byCampaign.get(row.campaignId) ?? {};
    bucket[row.status] = row._count._all;
    byCampaign.set(row.campaignId, bucket);
  }

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Create and manage SMS and email outreach campaigns"
      />
      <SectionTabs
        baseUrl="/campaigns"
        tabs={[
          { key: "sms", label: "SMS Campaigns" },
          { key: "email", label: "Email Campaigns" },
        ]}
        active={tab}
      />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">Gmail-based outreach to your email leads.</p>
        <ButtonLink href="/campaigns/new">New email campaign</ButtonLink>
      </div>

      {campaigns.length === 0 ? (
        <Card>
          <EmptyState
            title="No email campaigns yet"
            description="Connect a Gmail account, import leads, then create a campaign."
            action={<ButtonLink href="/campaigns/new">Create campaign</ButtonLink>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {campaigns.map((c) => {
            const bucket = byCampaign.get(c.id) ?? {};
            const total = KEYS.reduce((acc, k) => acc + (bucket[k] ?? 0), 0);
            return (
              <Card key={c.id}>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="mr-2 inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-xs font-semibold text-blue-700">
                        Email
                      </span>
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="font-semibold text-slate-900 hover:text-brand-700"
                      >
                        {c.name}
                      </Link>
                      <p className="mt-0.5 text-sm text-slate-500">
                        {campaignTemplateName(c) ? `Template: ${campaignTemplateName(c)}` : "No template"}
                      </p>
                    </div>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="mt-4 grid grid-cols-5 gap-2 text-center text-xs">
                    <div>
                      <p className="font-bold text-slate-900">{total}</p>
                      <p className="text-slate-400">Total</p>
                    </div>
                    <div>
                      <p className="font-bold text-emerald-600">{bucket["sent"] ?? 0}</p>
                      <p className="text-slate-400">Sent</p>
                    </div>
                    <div>
                      <p className="font-bold text-red-600">{bucket["failed"] ?? 0}</p>
                      <p className="text-slate-400">Failed</p>
                    </div>
                    <div>
                      <p className="font-bold text-slate-500">{bucket["skipped"] ?? 0}</p>
                      <p className="text-slate-400">Skipped</p>
                    </div>
                    <div>
                      <p className="font-bold text-slate-600">
                        {(bucket["pending"] ?? 0) + (bucket["sending"] ?? 0)}
                      </p>
                      <p className="text-slate-400">Remaining</p>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <Link
                      href={`/campaigns/${c.id}`}
                      className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
                    >
                      Manage
                    </Link>
                    <DeleteCampaignButton id={c.id} name={c.name} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
