import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  // Remove verification artifacts so only realistic demo data remains.
  const camp = await prisma.smsCampaign.findFirst({ where: { name: "API smoke test" } });
  if (camp) await prisma.smsCampaign.delete({ where: { id: camp.id } });

  await prisma.contact.deleteMany({ where: { phoneNumber: { in: ["+12025559001", "+12025559002"] } } });
  await prisma.webhookEvent.deleteMany({
    where: { x8MessageId: { in: ["test-inbound-001", "test-stop-001", "mock-dy860n-1000"] } },
  });
  await prisma.message.deleteMany({ where: { x8MessageId: { in: ["test-inbound-001", "test-stop-001"] } } });

  const counts = {
    campaigns: await prisma.smsCampaign.count(),
    contacts: await prisma.contact.count(),
    messages: await prisma.message.count(),
    replies: await prisma.reply.count(),
    events: await prisma.webhookEvent.count(),
  };
  console.log(JSON.stringify(counts));
  await prisma.$disconnect();
}

main();
