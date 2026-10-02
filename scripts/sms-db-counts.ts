import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const [campaigns, contacts, messages, replies, events] = await Promise.all([
    prisma.smsCampaign.count(),
    prisma.contact.count(),
    prisma.message.count(),
    prisma.reply.count(),
    prisma.webhookEvent.count(),
  ]);
  console.log(JSON.stringify({ campaigns, contacts, messages, replies, webhookEvents: events }));
  await prisma.$disconnect();
}

main();
