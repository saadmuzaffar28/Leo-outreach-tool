import { isX8Configured } from "@/lib/8x8";
import { Alert } from "@/components/ui";

export function DemoModeBanner() {
  if (isX8Configured()) return null;
  return (
    <div className="mb-6">
      <Alert kind="info">
        <strong>Demo mode</strong> — 8x8 API credentials are not configured, so sends are
        simulated with realistic mock data and never hit the live 8x8 API. Add{" "}
        <code className="rounded bg-white/60 px-1">X8_API_KEY</code> and{" "}
        <code className="rounded bg-white/60 px-1">X8_SUBACCOUNT_ID</code> to your{" "}
        <code className="rounded bg-white/60 px-1">.env</code> and restart to go live.
      </Alert>
    </div>
  );
}
