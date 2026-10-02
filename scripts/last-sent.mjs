import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const rows = await p.campaignRecipient.findMany({
  where: { status: "sent" },
  orderBy: { updatedAt: "desc" },
  take: 4,
  select: { recipient: true, updatedAt: true },
});
console.log("most recently completed sends:");
for (const r of rows) {
  console.log("  " + r.updatedAt.toISOString() + "   " + r.recipient);
}
console.log("now: " + new Date().toISOString());
const c = await p.dailySendCounter.findMany({ orderBy: { date: "desc" }, take: 2 });
for (const k of c) {
  console.log("counter " + k.date + " account=" + k.accountId + " sent=" + k.messagesSent);
}
await p.$disconnect();
