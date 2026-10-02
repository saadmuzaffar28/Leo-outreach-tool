import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, StatusBadge, ButtonLink, EmptyState } from "@/components/ui";
import { SectionTabs } from "@/components/section-tabs";
import { SmsTemplateManager } from "@/components/sms/template-manager";
import { TemplateActions } from "@/components/template-actions";

type SearchParams = {
  tab?: string;
};

export default async function TemplatesPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const tab = searchParams.tab === "email" ? "email" : "sms";

  if (tab === "sms") {
    return (
      <div>
        <PageHeader
          title="Templates"
          description="Reusable content for your SMS and email outreach"
        />
        <SectionTabs
          baseUrl="/templates"
          tabs={[
            { key: "sms", label: "SMS Templates" },
            { key: "email", label: "Email Templates" },
          ]}
          active={tab}
        />
        <SmsTemplateManager />
      </div>
    );
  }

  const templates = await prisma.emailTemplate.findMany({
    where: { userId: session.sub },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { campaigns: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Reusable content for your SMS and email outreach"
      />
      <SectionTabs
        baseUrl="/templates"
        tabs={[
          { key: "sms", label: "SMS Templates" },
          { key: "email", label: "Email Templates" },
        ]}
        active={tab}
      />

      <div className="mb-4">
        <ButtonLink href="/templates/new">New email template</ButtonLink>
      </div>

      {templates.length === 0 ? (
        <Card>
          <EmptyState
            title="No email templates yet"
            description="Create a template with variables like {{first_name}} to personalize each email."
            action={<ButtonLink href="/templates/new">Create template</ButtonLink>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((t) => (
            <Card key={t.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-xs font-semibold text-blue-700">
                      Email
                    </span>
                    <h3 className="truncate font-semibold text-slate-900">{t.name}</h3>
                    <StatusBadge status={t.isActive ? "active" : "inactive"} />
                  </div>
                  <p className="mt-0.5 truncate text-sm text-slate-500">Subject: {t.subject}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Used in {t._count.campaigns} campaign(s) · updated {t.updatedAt.toLocaleDateString()}
                  </p>
                  <div className="mt-3 flex gap-3">
                    <Link href={`/templates/${t.id}`} className="text-sm font-medium text-brand-600 hover:underline">
                      Edit
                    </Link>
                    <Link
                      href={`/campaigns/new?template=${t.id}`}
                      className="text-sm font-medium text-brand-600 hover:underline"
                    >
                      Use in campaign
                    </Link>
                  </div>
                </div>
                <div className="shrink-0">
                  <TemplateActions id={t.id} name={t.name} isActive={t.isActive} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
