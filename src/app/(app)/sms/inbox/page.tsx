import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { InboxClient } from "@/components/sms/inbox-client";

export const dynamic = "force-dynamic";

export default async function SmsInboxPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div>
      <PageHeader
        title="SMS Inbox"
        description="Customer replies and conversations"
      />
      <InboxClient />
    </div>
  );
}
