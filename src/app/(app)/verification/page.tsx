// Server component: it awaits getSession()/verificationStats() and hands
// serializable props to the client leaves below. Marking it "use client"
// made `next/headers` (via @/lib/auth) illegal in this module and broke the
// production build.
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { PageHeader } from "@/components/ui";
import { VerificationBulk } from "@/components/verification/verification-bulk";
import { verificationStats } from "@/lib/verification/service";
import { VerificationActions } from "./verification-actions";

export const dynamic = "force-dynamic";

export default async function VerificationPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const enabled = env.EMAIL_VERIFICATION_ENABLED;
  const stats = enabled ? await verificationStats(session.sub) : null;

  return (
    <div>
      <PageHeader
        title="Email Verification"
        description="Check whether addresses are likely deliverable before you send — pasted lists and CSVs are verified in the background by the self-hosted AfterShip engine, and results can gate campaigns."
      />
      <VerificationBulk
        enabled={enabled}
        initialStats={
          stats
            ? { ...stats, lastCheckedAt: stats.lastCheckedAt ? stats.lastCheckedAt.toISOString() : null }
            : null
        }
      />
      <VerificationActions
        enabled={enabled}
        stats={stats}
      />
    </div>
  );
}

function StatCard({ label, value, accent = false }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-brand-500 bg-brand-50" : "border-slate-200"}`}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}