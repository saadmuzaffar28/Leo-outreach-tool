import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { TemplateEditor } from "@/components/template-editor";

export default async function NewTemplatePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div>
      <PageHeader
        title="New template"
        description="Compose a personalized outreach email"
      />
      <TemplateEditor />
    </div>
  );
}