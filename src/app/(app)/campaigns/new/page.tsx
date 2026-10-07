import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui";
import { CampaignForm } from "@/components/campaign-form";
import { listGroups } from "@/lib/groups";
import { env } from "@/lib/env";

export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: { template?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const [googleAccounts, microsoftAccounts, smtpAccounts, templates, groups] = await Promise.all([
    prisma.googleAccount.findMany({ where: { userId: session.sub }, orderBy: { createdAt: "desc" } }),
    prisma.microsoftAccount.findMany({ where: { userId: session.sub }, orderBy: { createdAt: "desc" } }),
    prisma.smtpAccount.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, status: true, displayName: true },
    }),
    prisma.emailTemplate.findMany({
      where: { userId: session.sub, isActive: true },
      orderBy: { updatedAt: "desc" },
    }),
    listGroups(session.sub),
  ]);

  const preselect = templates.find((t) => t.id === searchParams.template)?.id ?? "";
  const senders = [
    ...googleAccounts.map((a) => ({ id: a.id, provider: "google" as const, email: a.googleEmail })),
    ...microsoftAccounts.map((a) => ({
      id: a.id,
      provider: "microsoft" as const,
      email: a.microsoftEmail,
    })),
    ...smtpAccounts.map((a) => ({
      id: a.id,
      provider: "smtp" as const,
      email: a.email,
      status: a.status,
      displayName: a.displayName,
    })),
  ];

  return (
    <div>
      <PageHeader
        title="New campaign"
        description="A campaign sends your outreach email to a chosen group, or to every lead in your list"
      />
      <CampaignForm
        accounts={senders}
        groups={groups}
        templates={templates.map((t) => ({
          id: t.id,
          name: t.name,
          subject: t.subject,
          body: t.body,
        }))}
        initialTemplateId={preselect}
        defaultSenderName={env.SENDER_NAME}
      />
    </div>
  );
}