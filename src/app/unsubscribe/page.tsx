import { verifyUnsubscribe } from "@/lib/suppression";
import { Card, Alert } from "@/components/ui";
import { UnsubscribeButton } from "@/components/unsubscribe-button";

export default function UnsubscribePage({
  searchParams,
}: {
  searchParams: { u?: string; e?: string; s?: string };
}) {
  const { u = "", e = "", s = "" } = searchParams;
  const valid = !!u && !!e && !!s && verifyUnsubscribe(u, e, s);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-black text-white">
          SB
        </div>
        <h1 className="text-xl font-bold text-slate-900">Unsubscribe</h1>
        <p className="mt-1 text-sm text-slate-500">
          {valid
            ? `Stop business development emails to ${e}.`
            : "This unsubscribe link is invalid or expired."}
        </p>
        <div className="mt-6">
          {valid ? (
            <Card className="p-6">
              <UnsubscribeButton userId={u} email={e} signature={s} />
            </Card>
          ) : (
            <Alert kind="error">Please use the unsubscribe link from the email you received.</Alert>
          )}
        </div>
      </div>
    </div>
  );
}