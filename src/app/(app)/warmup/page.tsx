import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { WarmupDashboard } from "@/components/warmup-dashboard";
import { listWarmupMailboxes, warmupStats, warmupEvents } from "@/lib/warmup/service";

export const dynamic = "force-dynamic";

export default async function WarmupPage() {
  // The session user id scopes every query. Resolving it here (rather than
  // passing a placeholder) matters: an empty userId would quietly render an
  // empty dashboard instead of erroring.
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.sub;

  // Fetched server-side so the first paint needs no client round trip. The
  // dashboard re-fetches through the API after every action.
  const [mailboxes, stats, events] = await Promise.all([
    listWarmupMailboxes(userId),
    warmupStats(userId, 7),
    warmupEvents(userId, { limit: 25 }),
  ]);

  return (
    <>
      <PageHeader
        title="Warm-up"
        description="Gradually ramp each mailbox with neutral internal traffic, and confirm delivery through IMAP."
      />
      {/* Date fields cross the server/client boundary as Dates (RSC serialises
          them) and as ISO strings after any JSON round trip; the view types
          accept either. */}
      <WarmupDashboard initialMailboxes={mailboxes} initialStats={stats} initialEvents={events} />
    </>
  );
}