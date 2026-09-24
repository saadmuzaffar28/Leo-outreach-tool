import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const m = await prisma.message.findFirst({ where: { direction: "outbound", status: "delivered" } });
  const c = await prisma.contact.findFirst({ where: { optOut: false } });
  console.log(JSON.stringify({ msgId: m?.x8MessageId, phone: c?.phoneNumber, contactId: c?.id }));
  await prisma.$disconnect();
}

main();
