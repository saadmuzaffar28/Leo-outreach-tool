import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { microsoftConfigured, MICROSOFT_SCOPES } from "@/lib/microsoft";
import { PageHeader, Card, CardHeader, Button, Alert } from "@/components/ui";
import { DisconnectGmailButton } from "@/components/disconnect-gmail-button";
import { DisconnectOutlookButton } from "@/components/disconnect-outlook-button";
import { AccountSignatureEditor } from "@/components/account-signature-editor";
import { SuppressionManager } from "@/components/suppression-manager";
import { SendSettingsForm } from "@/components/send-settings-form";
import { SmtpAccountsManager } from "@/components/smtp-accounts-manager";
import { getSendSettings } from "@/lib/settings";
import { dailyKey, getDailyCounter, isQuotaPaused, remainingBudget, isWithinDailyBudget } from "@/lib/quota";
import Link from "next/link";

const gmailConfigured = (): boolean => env.GOOGLE_CLIENT_ID !== "" && env.GOOGLE_CLIENT_SECRET !== "";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { google?: string; outlook?: string; reason?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const failureReason = searchParams.reason
    ? `Failure detail: ${searchParams.reason}`
    : "Could not connect. The authorization was cancelled, expired, or you denied access.";

  const [accounts, outlookAccounts, smtpAccounts, suppressions, settings] = await Promise.all([
    prisma.googleAccount.findMany({ where: { userId: session.sub }, orderBy: { createdAt: "desc" } }),
    prisma.microsoftAccount.findMany({ where: { userId: session.sub }, orderBy: { createdAt: "desc" } }),
    prisma.smtpAccount.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        host: true,
        port: true,
        security: true,
        status: true,
        lastTestedAt: true,
        lastTestError: true,
        createdAt: true,
      },
    }),
    prisma.suppression.findMany({ where: { userId: session.sub }, orderBy: { createdAt: "desc" } }),
    getSendSettings(session.sub),
  ]);

  const today = dailyKey();
  const googleUsage = await Promise.all(
    accounts.map(async (a) => {
      const c = await getDailyCounter("google", a.id, session.sub, today);
      return {
        accountId: a.id,
        provider: "google" as const,
        email: a.googleEmail,
        messagesSent: c.messagesSent,
        messagesFailed: c.messagesFailed,
        messagesSkipped: c.messagesSkipped,
        quotaPaused: isQuotaPaused(a.quotaPausedUntil),
        quotaPausedUntil: a.quotaPausedUntil,
        quotaMessage: a.quotaMessage,
      };
    }),
  );
  const microsoftUsage = await Promise.all(
    outlookAccounts.map(async (a) => {
      const c = await getDailyCounter("microsoft", a.id, session.sub, today);
      return {
        accountId: a.id,
        provider: "microsoft" as const,
        email: a.microsoftEmail,
        messagesSent: c.messagesSent,
        messagesFailed: c.messagesFailed,
        messagesSkipped: c.messagesSkipped,
        quotaPaused: isQuotaPaused(a.quotaPausedUntil),
        quotaPausedUntil: a.quotaPausedUntil,
        quotaMessage: a.quotaMessage,
      };
    }),
  );
  const usage = [...googleUsage, ...microsoftUsage];
  const totalConnected = accounts.length + outlookAccounts.length;

  return (
    <div>
      <PageHeader title="Settings" description="Email connections, suppression list, and sending limits" />

      {searchParams.google === "connected" ? (
        <div className="mb-6"><Alert kind="success">Gmail account connected successfully.</Alert></div>
      ) : null}
      {searchParams.google === "error" ? (
        <div className="mb-6">
          <Alert kind="error">Could not connect Gmail. {failureReason}</Alert>
        </div>
      ) : null}
      {searchParams.outlook === "connected" ? (
        <div className="mb-6"><Alert kind="success">Outlook account connected successfully.</Alert></div>
      ) : null}
      {searchParams.outlook === "error" ? (
        <div className="mb-6">
          <Alert kind="error">Could not connect Outlook. {failureReason}</Alert>
        </div>
      ) : null}

      {settings.sendMode === "test" ? (
        <div className="mb-6"><Alert kind="error">TEST MODE is ON — no real emails will be sent. Sends are simulated and logged only.</Alert></div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Gmail connection"
            description={
              totalConnected === 0
                ? "Connect a Gmail or Outlook account below to send campaigns."
                : "Connect the Gmail account you send from."
            }
            actions={
              gmailConfigured() ? (
                <a href="/api/google/connect"><Button>Connect Gmail</Button></a>
              ) : undefined
            }
          />
          <div className="px-6 py-4">
            {!gmailConfigured() ? (
              <p className="text-sm text-slate-500">
                Gmail OAuth is not configured. Set{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">GOOGLE_CLIENT_ID</code> and{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">GOOGLE_CLIENT_SECRET</code>{" "}
                in the .env file to enable it. {" "}
                <Link href="https://console.cloud.google.com/" className="font-medium text-brand-600 hover:underline">
                  Google Cloud Console
                </Link>
              </p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-slate-500">
                No account connected yet. Click “Connect Gmail” to authorize {`Leo's`} outreach. No passwords are ever stored.
              </p>
            ) : null}

            {accounts.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {accounts.map((a) => (
                  <li key={a.id} className="py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium text-slate-900">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="truncate">{a.googleEmail}</span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {a.signatureOverride
                            ? "Using the custom signature below"
                            : a.signature
                              ? "Scopes: send + signature · signature captured from Gmail"
                              : "Scopes: send only · reconnect to capture the saved Gmail signature"}
                        </p>
                      </div>
                      <DisconnectGmailButton accountId={a.id} email={a.googleEmail} />
                    </div>
                    <AccountSignatureEditor
                      accountId={a.id}
                      email={a.googleEmail}
                      initial={a.signatureOverride ?? ""}
                      hasGmailSignature={a.signature !== null}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Microsoft Outlook connection"
            description="Connect an Outlook/Hotmail or Microsoft 365 mailbox. Uses Microsoft Graph OAuth 2.0 — no passwords are ever stored."
            actions={
              microsoftConfigured() ? (
                <a href="/api/auth/microsoft"><Button>Connect Outlook</Button></a>
              ) : undefined
            }
          />
          <div className="px-6 py-4">
            {!microsoftConfigured() ? (
              <p className="text-sm text-slate-500">
                Microsoft Outlook OAuth is not configured. Set{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">MICROSOFT_CLIENT_ID</code> and{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">MICROSOFT_CLIENT_SECRET</code>{" "}
                in the .env file to enable it (create an app in the{" "}
                <Link href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" className="font-medium text-brand-600 hover:underline">
                  Microsoft Entra admin center
                </Link>
                ).
              </p>
            ) : outlookAccounts.length === 0 ? (
              <p className="text-sm text-slate-500">
                No Outlook account connected yet. Click “Connect Outlook” to authorize {`Leo's`} outreach. Sending uses the{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">Mail.Send</code> delegated permission.
              </p>
            ) : null}

            {outlookAccounts.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {outlookAccounts.map((a) => (
                  <li key={a.id} className="py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium text-slate-900">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="truncate">{a.microsoftEmail}</span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {a.displayName ? `Signed in as ${a.displayName} · ` : ""}
                          Scopes: {a.scopes.length > 0 ? a.scopes.join(", ") : MICROSOFT_SCOPES}
                        </p>
                      </div>
                      <DisconnectOutlookButton accountId={a.id} email={a.microsoftEmail} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="SMTP / custom email connection"
          description="Send campaigns from your own mail server (e.g. a mailbox on your domain). Credentials are encrypted at rest and never returned to the browser."
        />
        <SmtpAccountsManager
          initial={smtpAccounts.map((a) => ({
            id: a.id,
            email: a.email,
            host: a.host,
            port: a.port,
            security: a.security,
            status: a.status,
            lastTestedAt: a.lastTestedAt ? a.lastTestedAt.toISOString() : null,
            lastTestError: a.lastTestError,
            createdAt: a.createdAt.toISOString(),
          }))}
        />
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Suppression list"
          description="Suppressed addresses are never emailed. Activating opt-out links adds addresses here automatically."
        />
        <div className="px-6 py-4">
          <SuppressionManager
            initial={suppressions.map((s) => ({ id: s.id, email: s.email, reason: s.reason }))}
          />
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Sending limits"
          description="Application-level controls. The email provider's real limits and policy always apply and may be lower — settings here are an extra conservative layer."
        />
        <div className="px-6 py-4">
          <SendSettingsForm initial={settings} />
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Today's account usage"
          description={`Per-account persistent counters for ${today}`}
        />
        <div className="px-6 py-4">
          {usage.length === 0 ? (
            <p className="text-sm text-slate-500">Connect a Gmail or Outlook account to see daily send counters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-6 py-3">Account</th>
                    <th className="px-4 py-3 text-right">Sent today</th>
                    <th className="px-4 py-3 text-right">Limit</th>
                    <th className="px-4 py-3 text-right">Remaining</th>
                    <th className="px-4 py-3 text-right">Failed</th>
                    <th className="px-4 py-3 text-right">Skipped</th>
                    <th className="px-6 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {usage.map((u) => {
                    const remaining = remainingBudget(u.messagesSent, settings.dailySendLimit);
                    const within = isWithinDailyBudget(u.messagesSent, settings.dailySendLimit);
                    return (
                      <tr key={`${u.provider}:${u.accountId}`} className="hover:bg-slate-50">
                        <td className="px-6 py-3">
                          <span className="font-medium text-slate-900">{u.email}</span>
                          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                            {u.provider === "microsoft" ? "Outlook" : "Gmail"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600">{u.messagesSent}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{settings.dailySendLimit}</td>
                        <td className={`px-4 py-3 text-right ${within ? "text-emerald-600" : "text-red-600"}`}>
                          {remaining}
                        </td>
                        <td className="px-4 py-3 text-right text-red-600">{u.messagesFailed}</td>
                        <td className="px-4 py-3 text-right text-slate-500">{u.messagesSkipped}</td>
                        <td className="px-6 py-3">
                          {u.quotaPaused ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                              Rate-limiting — retrying automatically
                              {u.quotaPausedUntil ? ` until ${u.quotaPausedUntil.toLocaleTimeString()}` : ""}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Sending normally
                            </span>
                          )}
                          {u.quotaMessage ? (
                            <p className="mt-1 max-w-[280px] truncate text-xs text-slate-400" title={u.quotaMessage}>
                              {u.quotaMessage}
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}