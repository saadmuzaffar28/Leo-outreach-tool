import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  await prisma.webhookEvent.deleteMany({});
  await prisma.reply.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.smsCampaign.deleteMany({});
  await prisma.contact.deleteMany({});
  console.log("sms tables cleared");
  await prisma.$disconnect();
}

main();
