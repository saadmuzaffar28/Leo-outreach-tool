import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smsContactSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { isValidPhoneNumber, normalizePhoneNumber } from "@/lib/8x8";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") ?? "25") || 25));
  const search = (url.searchParams.get("search") ?? "").trim();

  const where = {
    userId: session.sub,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { phoneNumber: { contains: search } },
          ],
        }
      : {}),
  };

  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { messages: true } } },
    }),
  ]);

  return jsonResponse({ total, page, pageSize, contacts });
}

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
  const parsed = smsContactSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid contact");

  const phoneNumber = normalizePhoneNumber(parsed.data.phoneNumber);
  if (!isValidPhoneNumber(phoneNumber)) return badRequest("Invalid phone number");

  const existing = await prisma.contact.findFirst({
    where: { userId: session.sub, phoneNumber },
    select: { id: true },
  });
  if (existing) return badRequest("A contact with this phone number already exists");

  const contact = await prisma.contact.create({
    data: { userId: session.sub, name: parsed.data.name, phoneNumber },
  });
  return jsonResponse({ contact }, 201);
}

/** Delete ALL contacts for the current user. Requires ?confirm=all. */
export async function DELETE(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  if (url.searchParams.get("confirm") !== "all") {
    return badRequest("Missing confirm=all parameter");
  }

  const deleted = await prisma.contact.deleteMany({ where: { userId: session.sub } });
  return jsonResponse({ ok: true, deleted: deleted.count });
}
