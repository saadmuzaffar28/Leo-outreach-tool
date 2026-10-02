import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSmsCampaignRows } from "@/lib/sms-stats";
import { PageHeader, ButtonLink } from "@/components/ui";
import { DemoModeBanner } from "@/components/sms/demo-banner";
import { SmsCampaignsTable } from "@/components/sms/sms-campaigns-table";

export const dynamic = "force-dynamic";

export default async function SmsCampaignsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const campaigns = await getSmsCampaignRows(session.sub);

  return (
    <div>
      <PageHeader
        title="SMS Campaigns"
        description="All your 8x8 SMS campaigns"
        actions={<ButtonLink href="/sms/campaigns/new">New campaign</ButtonLink>}
      />
      <DemoModeBanner />
      <SmsCampaignsTable campaigns={campaigns} />
    </div>
  );
}
