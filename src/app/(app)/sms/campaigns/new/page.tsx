import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { NewCampaignForm } from "@/components/sms/new-campaign-form";

export default async function NewSmsCampaignPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div>
      <PageHeader
        title="New SMS campaign"
        description="Send a personalized SMS to your opted-in contacts via 8x8"
      />
      <NewCampaignForm defaultSource="8x8" />
    </div>
  );
}
