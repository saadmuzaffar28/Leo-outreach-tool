import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, CardHeader, ButtonLink, TextInput, EmptyState, Button } from "@/components/ui";
import { SectionTabs } from "@/components/section-tabs";
import { ContactsManager } from "@/components/sms/contacts-manager";
import { LeadImport } from "@/components/lead-import";
import { GroupsManager } from "@/components/groups-manager";
import { DeleteLeadButton } from "@/components/delete-lead-button";
import { DeleteAllLeadsButton } from "@/components/delete-all-leads-button";
import { RemoveFromGroupButton } from "@/components/remove-from-group-button";
import { listGroups, groupLeadWhere } from "@/lib/groups";
import { VerificationBadge } from "@/components/verification/verification-badge";
import { statusesFor } from "@/lib/verification/service";

const PAGE_SIZE = 25;

type SearchParams = {
  q?: string;
  sort?: string;
  dir?: string;
  page?: string;
  tab?: string;
  group?: string;
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

const TABS = [
  { key: "sms", label: "SMS Contacts" },
  { key: "email", label: "Email Leads" },
  { key: "groups", label: "Groups" },
];

export default async function LeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const tab = ["email", "groups"].includes(searchParams.tab ?? "") ? searchParams.tab! : "sms";

  // Groups are needed by the Groups tab, the group detail view and the import
  // dialog, so they load once for every email/groups tab.
  const groups = tab === "groups" || tab === "email" ? await listGroups(session.sub) : [];

  if (tab === "sms") {
    return (
      <div>
        <PageHeader
          title="Leads"
          description="Manage your SMS contacts and email leads"
        />
        <SectionTabs baseUrl="/leads" tabs={TABS} active={tab} />
        <ContactsManager />
      </div>
    );
  }

  // ------------------------------------------------------------- groups tab
  if (tab === "groups") {
    return (
      <div>
        <PageHeader
          title="Leads"
          description="Organise contacts into named groups and target them with campaigns"
        />
        <SectionTabs baseUrl="/leads" tabs={TABS} active={tab} />
        <GroupsManager initialGroups={groups} />
      </div>
    );
  }

  // ---------------------------------------------------------- email / group
  const groupId = searchParams.group?.trim() || null;
  const activeGroup = groupId ? groups.find((g) => g.id === groupId) ?? null : null;

  // A group id that no longer exists (deleted) falls back to All Contacts
  // rather than showing an error.
  const scopedGroupId = activeGroup?.id ?? null;

  const q = searchParams.q?.trim() ?? "";
  const sort = searchParams.sort ?? "createdAt";
  const dir = searchParams.dir === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);

  const baseWhere = groupLeadWhere(session.sub, scopedGroupId);
  const where = {
    ...baseWhere,
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

  // Stored verification results for this page's addresses (one query). Rows
  // without a record render as "Unverified" with a per-row Verify button.
  const verificationMap = await statusesFor(
    session.sub,
    leads.map((l) => l.email),
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Preserve the group scope across paging/sorting/search.
  const qs = (p: number) =>
    `?tab=email${scopedGroupId ? `&group=${encodeURIComponent(scopedGroupId)}` : ""}` +
    `&q=${encodeURIComponent(q)}&sort=${sort}&dir=${dir}&page=${p}`;
  const nextHref = qs(page + 1);
  const prevHref = qs(page - 1);

  return (
    <div>
      <PageHeader
        title={activeGroup ? activeGroup.name : "Leads"}
        description={
          activeGroup
            ? `${activeGroup.contactCount} contact${activeGroup.contactCount === 1 ? "" : "s"}${
                q ? ` matching "${q}"` : ""
              }`
            : `${total} lead(s) in your list`
        }
        actions={
          <>
            {activeGroup ? (
              <ButtonLink href="/leads?tab=email" variant="secondary">
                All Contacts
              </ButtonLink>
            ) : (
              <>
                <DeleteAllLeadsButton count={total} />
                <ButtonLink href="/api/leads/export" variant="secondary">
                  Export CSV
                </ButtonLink>
                <LeadImport groups={groups} />
              </>
            )}
          </>
        }
      />

      <SectionTabs baseUrl="/leads" tabs={TABS} active={tab} />

      {activeGroup ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <ButtonLink href={`/api/leads/export?group=${encodeURIComponent(activeGroup.id)}`} variant="secondary">
            Export CSV
          </ButtonLink>
          <LeadImport groups={groups} />
          {activeGroup.description ? (
            <span className="text-sm text-slate-500">{activeGroup.description}</span>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader
          title={activeGroup ? "Contacts in this group" : "Lead list"}
          actions={
            <form method="GET" className="flex items-center gap-2">
              <input type="hidden" name="tab" value="email" />
              {scopedGroupId ? (
                <input type="hidden" name="group" value={scopedGroupId} />
              ) : null}
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
            title={
              activeGroup
                ? "This group has no matching contacts"
                : q
                  ? "No matching leads"
                  : "No leads yet"
            }
            description={
              activeGroup
                ? "Import contacts into this group, or remove the search filter."
                : q
                  ? "Try a different search term."
                  : "Import a CSV to start building your list."
            }
            action={
              activeGroup ? (
                <LeadImport groups={groups} />
              ) : q ? undefined : (
                <LeadImport groups={groups} />
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Verified</th>
                  <th className="px-4 py-3">Practice</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Custom 1</th>
                  <th className="px-4 py-3">Custom 2</th>
                  <th className="px-4 py-3">Added</th>
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
                    <td className="px-4 py-3">
                      <VerificationBadge
                        email={l.email}
                        initialStatus={verificationMap.get(l.email.trim().toLowerCase())?.status ?? null}
                        initialConfidence={verificationMap.get(l.email.trim().toLowerCase())?.confidence ?? null}
                      />
                    </td>
                    <td className="px-4 py-3 text-slate-600">{l.practiceName ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{l.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{l.customField1 ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{l.customField2 ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {l.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {activeGroup ? (
                        <RemoveFromGroupButton
                          groupId={activeGroup.id}
                          leadId={l.id}
                          email={l.email}
                        />
                      ) : (
                        <DeleteLeadButton id={l.id} email={l.email} />
                      )}
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
