import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, CardHeader, ButtonLink, TextInput, EmptyState, Button } from "@/components/ui";
import { SectionTabs } from "@/components/section-tabs";
import { ContactsManager } from "@/components/sms/contacts-manager";
import { LeadImport } from "@/components/lead-import";
import { DeleteLeadButton } from "@/components/delete-lead-button";
import { DeleteAllLeadsButton } from "@/components/delete-all-leads-button";

const PAGE_SIZE = 25;

type SearchParams = {
  q?: string;
  sort?: string;
  dir?: string;
  page?: string;
  tab?: string;
};

function sortClause(sort: string, dir: "asc" | "desc") {
  switch (sort) {
    case "name":
      return [{ firstName: dir }, { lastName: dir }];
    case "practice":
      return { practiceName: dir };
    default:
      return { createdAt: dir };
  }
}

export const dynamic = "force-dynamic";

export default async function LeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const tab = searchParams.tab === "email" ? "email" : "sms";

  if (tab === "sms") {
    return (
      <div>
        <PageHeader
          title="Leads"
          description="Manage your SMS contacts and email leads"
        />
        <SectionTabs
          baseUrl="/leads"
          tabs={[
            { key: "sms", label: "SMS Contacts" },
            { key: "email", label: "Email Leads" },
          ]}
          active={tab}
        />
        <ContactsManager />
      </div>
    );
  }

  const q = searchParams.q?.trim() ?? "";
  const sort = searchParams.sort ?? "createdAt";
  const dir = searchParams.dir === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);

  const where = {
    userId: session.sub,
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" as const } },
            { lastName: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
            { practiceName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: sortClause(sort, dir),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const nextHref = `?tab=email&q=${encodeURIComponent(q)}&sort=${sort}&dir=${dir}&page=${page + 1}`;
  const prevHref = `?tab=email&q=${encodeURIComponent(q)}&sort=${sort}&dir=${dir}&page=${page - 1}`;

  return (
    <div>
      <PageHeader
        title="Leads"
        description={`${total} lead(s) in your list`}
        actions={
          <>
            <DeleteAllLeadsButton count={total} />
            <ButtonLink href="/api/leads/export" variant="secondary">
              Export CSV
            </ButtonLink>
            <LeadImport />
          </>
        }
      />

      <SectionTabs
        baseUrl="/leads"
        tabs={[
          { key: "sms", label: "SMS Contacts" },
          { key: "email", label: "Email Leads" },
        ]}
        active={tab}
      />

      <Card>
        <CardHeader
          title="Lead list"
          actions={
            <form method="GET" className="flex items-center gap-2">
              <input type="hidden" name="tab" value="email" />
              <TextInput
                name="q"
                defaultValue={q}
                placeholder="Search name, email, practice…"
                className="w-64"
              />
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={dir} />
              <Button type="submit" variant="secondary">
                Search
              </Button>
            </form>
          }
        />

        {leads.length === 0 ? (
          <EmptyState
            title={q ? "No matching leads" : "No leads yet"}
            description={
              q
                ? "Try a different search term."
                : "Import a CSV to start building your list."
            }
            action={q ? undefined : <LeadImport />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Practice</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Custom 1</th>
                  <th className="px-4 py-3">Custom 2</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {leads.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 font-medium text-slate-900">
                      {l.firstName} {l.lastName ?? ""}
                    </td>
                    <td className="px-4 py-3">{l.email}</td>
                    <td className="px-4 py-3 text-slate-600">{l.practiceName ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{l.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{l.customField1 ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{l.customField2 ?? "—"}</td>
                    <td className="px-6 py-3 text-right">
                      <DeleteLeadButton id={l.id} email={l.email} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-100 px-6 py-3 text-sm text-slate-500">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <ButtonLink href={prevHref} variant="secondary">
                  Previous
                </ButtonLink>
              ) : null}
              {page < totalPages ? (
                <ButtonLink href={nextHref} variant="secondary">
                  Next
                </ButtonLink>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
