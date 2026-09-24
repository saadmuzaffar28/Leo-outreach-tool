import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smsReplySchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { sendSingleSms, isValidPhoneNumber, normalizePhoneNumber } from "@/lib/8x8";

/** Send an ad-hoc reply to a customer from the inbox. */
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
  const parsed = smsReplySchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid reply");

  const phoneNumber = normalizePhoneNumber(parsed.data.phoneNumber);
  if (!isValidPhoneNumber(phoneNumber)) return badRequest("Invalid phone number");

  // Never message a contact who opted out.
  const contact = await prisma.contact.findFirst({
    where: { userId: session.sub, phoneNumber },
  });
  if (contact?.optOut) {
    return badRequest("This contact has opted out and cannot be messaged");
  }

  const lastOutbound = await prisma.message.findFirst({
    where: { userId: session.sub, phoneNumber, direction: "outbound" },
    orderBy: { createdAt: "desc" },
    select: { source: true },
  });

  const result = await sendSingleSms({
    userId: session.sub,
    contactId: contact?.id ?? null,
    campaignId: null,
    phoneNumber,
    message: parsed.data.message,
    source: lastOutbound?.source ?? (process.env.X8_SUBACCOUNT_ID || "8x8"),
  });

  if (result.status === "failed") {
    return jsonResponse({ error: result.error ?? "Send failed" }, 502);
  }
  return jsonResponse({ ok: true, ...result }, 201);
}
