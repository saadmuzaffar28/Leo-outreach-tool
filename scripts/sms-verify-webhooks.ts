import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const [replies, inbound, events, optedOut] = await Promise.all([
    prisma.reply.count({ where: { phoneNumber: "+12025551000" } }),
    prisma.message.count({ where: { direction: "inbound", x8MessageId: { in: ["test-inbound-001", "test-stop-001"] } } }),
    prisma.webhookEvent.count(),
    prisma.contact.findFirst({ where: { phoneNumber: "+12025551001" }, select: { optOut: true } }),
  ]);
  console.log(JSON.stringify({ repliesFor1000: replies, inboundStored: inbound, webhookEvents: events, contact1001OptedOut: optedOut?.optOut }));
  await prisma.$disconnect();
}

main();
