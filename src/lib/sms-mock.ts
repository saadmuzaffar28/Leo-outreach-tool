import { prisma } from "@/lib/prisma";
import { isX8Configured } from "@/lib/8x8";

const MOCK_NAMES = [
  "Jane Cooper", "Michael Reyes", "Priya Sharma", "David Kim", "Sofia Alvarez",
  "Liam O'Connor", "Emma Thompson", "Noah Patel", "Ava Martinez", "Ethan Brooks",
  "Mia Nguyen", "Lucas Weber", "Isabella Rossi", "Owen Murphy", "Zoe Campbell",
  "Raj Verma", "Grace Liu", "Carlos Mendez", "Nina Kowalski", "Tyler Grant",
];

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Sam", "Chris", "Robin", "Dana", "Jamie"];

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

/**
 * Seeds realistic demo SMS data when 8x8 is NOT configured and the user has
 * no SMS data yet. Clearly marked with mock x8 message ids so demo data can
 * never be confused with live traffic.
 */
export async function ensureSmsMockData(userId: string): Promise<boolean> {
  if (isX8Configured()) return false;

  const existing = await prisma.smsCampaign.count({ where: { userId } });
  const existingContacts = await prisma.contact.count({ where: { userId } });
  if (existing > 0 || existingContacts > 0) return false;

  // Deterministic-ish randomness for stable-looking demos.
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  // Contacts — ~15% opted out.
  const contacts: Array<{ id: string; name: string; phoneNumber: string; optOut: boolean }> = [];
  for (let i = 0; i < MOCK_NAMES.length; i++) {
    const name = MOCK_NAMES[i];
    const optOut = i % 7 === 3;
    const c = await prisma.contact.create({
      data: {
        userId,
        name,
        phoneNumber: `+1202555${String(1000 + i).padStart(4, "0")}`,
        optOut,
        status: optOut ? "opted_out" : "active",
        createdAt: new Date(Date.now() - (30 - i) * 86_400_000),
      },
    });
    contacts.push({ id: c.id, name: c.name, phoneNumber: c.phoneNumber, optOut });
  }

  const activeContacts = contacts.filter((c) => !c.optOut);

  const campaignDefs = [
    { name: "Invoice reminders — July", message: "Hi {{name}}, friendly reminder that your July invoice is due tomorrow. Reply STOP to opt out.", daysAgo: 24 },
    { name: "Payment confirmation blast", message: "Hi {{name}}, we received your payment. Thank you! Reply STOP to opt out.", daysAgo: 17 },
    { name: "August statement ready", message: "Hello {{name}}, your August statement is ready in the portal. Reply STOP to opt out.", daysAgo: 9 },
    { name: "Insurance follow-up", message: "Hi {{name}}, following up on your pending insurance claim. Call us or reply here. Reply STOP to opt out.", daysAgo: 3 },
  ];

  for (const def of campaignDefs) {
    const recipients = activeContacts.filter(() => rnd() < 0.75);
    if (recipients.length === 0) continue;

    const createdAt = new Date(Date.now() - def.daysAgo * 86_400_000);
    const campaign = await prisma.smsCampaign.create({
      data: {
        userId,
        name: def.name,
        message: def.message,
        source: "+12025550100",
        status: "sent",
        createdAt,
        completedAt: new Date(createdAt.getTime() + 3_600_000),
      },
    });

    for (const r of recipients) {
      const sentAt = new Date(createdAt.getTime() + Math.floor(rnd() * 3_600_000));
      const roll = rnd();
      // Realistic distribution: ~93% delivered, ~4% undelivered, ~2% failed, ~1% rejected
      let status: string;
      if (roll < 0.93) status = "delivered";
      else if (roll < 0.97) status = "undelivered";
      else if (roll < 0.99) status = "failed";
      else status = "rejected";
      const body = def.message.replace(/\{\{\s*name\s*\}\}/gi, r.name.split(" ")[0]);
      const msg = await prisma.message.create({
        data: {
          userId,
          campaignId: campaign.id,
          contactId: r.id,
          x8MessageId: `mock-${campaign.id.slice(-6)}-${r.phoneNumber.slice(-4)}`,
          phoneNumber: r.phoneNumber,
          message: body,
          direction: "outbound",
          status,
          source: "+12025550100",
          sentAt,
          deliveredAt: status === "delivered" ? new Date(sentAt.getTime() + 30_000 + rnd() * 300_000) : null,
          failedAt: status !== "delivered" && status !== "sent" ? new Date(sentAt.getTime() + 60_000) : null,
          lastError: status === "undelivered" ? "15 Invalid destination" : null,
          createdAt: sentAt,
        },
      });

      // ~11% of delivered messages get a reply.
      if (status === "delivered" && rnd() < 0.11) {
        const replyAt = new Date(sentAt.getTime() + 600_000 + rnd() * 86_400_000);
        const replyText = pick(
          [
            "Thanks for the heads up!",
            "When is the exact due date?",
            "I already paid yesterday.",
            "Can you send me the link again?",
            "Please stop contacting me",
            "Who do I call about this?",
            "Got it, thank you.",
          ],
          rnd,
        );
        await prisma.reply.create({
          data: {
            userId,
            messageId: msg.id,
            campaignId: campaign.id,
            contactId: r.id,
            phoneNumber: r.phoneNumber,
            message: replyText,
            receivedAt: replyAt,
          },
        });
        await prisma.message.create({
          data: {
            userId,
            campaignId: campaign.id,
            contactId: r.id,
            x8MessageId: `mock-in-${msg.id.slice(-6)}`,
            phoneNumber: r.phoneNumber,
            message: replyText,
            direction: "inbound",
            status: "received",
            source: "+12025550100",
            createdAt: replyAt,
          },
        });
        // STOP replies mark the contact opted out.
        if (/stop/i.test(replyText)) {
          await prisma.contact.update({ where: { id: r.id }, data: { optOut: true, status: "opted_out" } });
        }
      }
    }
  }

  return true;
}
