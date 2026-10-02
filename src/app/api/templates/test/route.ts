import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { templateTestSendSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { assertOnlySupportedVariables, personalize, PREVIEW_LEAD } from "@/lib/personalization";
import { decryptAccount, getAuthorizedOAuthClient, sendMessage } from "@/lib/google";
import {
  decryptMicrosoftAccount,
  encryptMicrosoftTokens,
  getAuthorizedMicrosoft,
  sendMicrosoftMail,
} from "@/lib/microsoft";
import { plainTextToHtml } from "@/lib/message";
import type { MailMessage } from "@/lib/message";
import { env } from "@/lib/env";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = templateTestSendSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid test recipient");

  try {
    assertOnlySupportedVariables(
      parsed.data.template.subject + "\n" + parsed.data.template.body,
    );
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const [account, microsoftAccount] = await Promise.all([
    prisma.googleAccount.findFirst({
      where: { userId: session.sub },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.microsoftAccount.findFirst({
      where: { userId: session.sub },
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  const useMicrosoft =
    microsoftAccount &&
    (account == null || microsoftAccount.updatedAt.getTime() >= account.updatedAt.getTime());

  if (!useMicrosoft && !account) {
    return badRequest("Connect a Gmail or Outlook account before sending a test email");
  }

  const accountData = useMicrosoft ? decryptMicrosoftAccount(microsoftAccount!) : decryptAccount(account!);
  const subject = `[TEST] ${personalize(parsed.data.template.subject, PREVIEW_LEAD).trim()}`;
  const bodyText = personalize(parsed.data.template.body, PREVIEW_LEAD);

  const useSignature = parsed.data.template.useSignature !== false;
  let signatureHtml: string | null = null;
  if (useSignature) {
    const templateSig = parsed.data.template.signatureOverride?.trim();
    signatureHtml = templateSig
      ? plainTextToHtml(templateSig)
      : useMicrosoft
        ? (microsoftAccount!.signatureOverride
            ? plainTextToHtml(microsoftAccount!.signatureOverride)
            : null)
        : account!.signatureOverride
          ? plainTextToHtml(account!.signatureOverride)
          : (accountData as Awaited<ReturnType<typeof decryptAccount>>).signature;
  }

  const message: MailMessage = {
    fromName: env.SENDER_NAME,
    fromEmail: useMicrosoft
      ? (accountData as { microsoftEmail: string }).microsoftEmail
      : (accountData as { googleEmail: string }).googleEmail,
    to: parsed.data.to,
    subject,
    body: bodyText,
    unsubscribeUrl: null,
    signatureHtml,
  };

  try {
    if (useMicrosoft) {
      const msTokens = accountData as Awaited<ReturnType<typeof decryptMicrosoftAccount>>;
      const { accessToken, refreshedTokens } = await getAuthorizedMicrosoft(msTokens);
      if (refreshedTokens) {
        await prisma.microsoftAccount.update({
          where: { id: msTokens.id },
          data: encryptMicrosoftTokens(refreshedTokens),
        });
      }
      await sendMicrosoftMail(accessToken, message);
      return jsonResponse({ ok: true, messageId: "microsoft-graph", to: parsed.data.to });
    }
    const googleTokens = accountData as Awaited<ReturnType<typeof decryptAccount>>;
    const { client, refreshedTokens } = await getAuthorizedOAuthClient(googleTokens);
    if (refreshedTokens) {
      await prisma.googleAccount.update({
        where: { id: googleTokens.id },
        data: refreshedTokens,
      });
    }
    const { messageId } = await sendMessage(client, message);
    return jsonResponse({ ok: true, messageId, to: parsed.data.to });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return badRequest(`Test email failed to send: ${detail}`);
  }
}