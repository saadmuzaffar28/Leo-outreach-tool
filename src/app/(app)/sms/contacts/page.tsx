import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ContactsManager } from "@/components/sms/contacts-manager";

export const dynamic = "force-dynamic";

export default async function SmsContactsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div>
      <PageHeader
        title="Contacts"
        description="Manage SMS recipients — opted-out contacts are never messaged"
      />
      <ContactsManager />
    </div>
  );
}
