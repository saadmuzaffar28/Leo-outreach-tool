import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import { getSession, isOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui";
import { TemplateEditor } from "@/components/template-editor";

export default async function EditTemplatePage({ params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const template = await prisma.emailTemplate.findUnique({ where: { id: params.id } });
  if (!template || !isOwner(session, template.userId)) notFound();

  return (
    <div>
      <PageHeader title="Edit template" description={`Editing "${template.name}"`} />
      <TemplateEditor
        id={template.id}
        initial={{
          name: template.name,
          subject: template.subject,
          body: template.body,
          useSignature: template.useSignature,
          signatureOverride: template.signatureOverride ?? "",
        }}
      />
    </div>
  );
}