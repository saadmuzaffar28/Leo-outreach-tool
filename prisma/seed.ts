import "dotenv/config";

import { PrismaClient } from "@prisma/client";
import { env } from "../src/lib/env";
import { hashPassword } from "../src/lib/auth";

const prisma = new PrismaClient();

async function main() {
  const email = env.ADMIN_EMAIL.toLowerCase();
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, name: env.ADMIN_NAME, passwordHash },
  });

  const leadCount = await prisma.lead.count({ where: { userId: user.id } });
  if (leadCount === 0) {
    const samples = [
      { firstName: "Alex", lastName: "Rivera", email: "alex@example.com", practiceName: "Green Valley Family Practice", phone: "480-555-0123" },
      { firstName: "Jamie", lastName: "Kim", email: "jamie@example.com", practiceName: "Summit Orthopedics", phone: "602-555-0199" },
      { firstName: "Priya", lastName: "Patel", email: "priya@example.com", practiceName: "Lakeside Dermatology", phone: "480-555-0145" },
      { firstName: "Marcus", lastName: "Cole", email: "marcus@example.com", practiceName: "Northgate Pediatrics", phone: "623-555-0111" },
      { firstName: "Sara", lastName: "Nguyen", email: "sara@example.com", practiceName: "Cedar Heart & Vascular", phone: "520-555-0188" },
    ];
    await prisma.lead.createMany({
      data: samples.map((s) => ({ userId: user.id, ...s })),
    });
    console.log(`Seeded ${samples.length} sample leads.`);
  }

  const templates = [
      {
        name: "Revenue Cycle Review",
        subject: "Revenue Cycle Review",
        body: `Hi {{first_name}},\n\nMy name is Ted, and I'm with Star Billing, a leading RCM company.\n\nMany practices have 10%–15% of outstanding revenue that may still be recoverable. Our team handles complete medical billing, A/R follow-up, and denial recovery, so you can focus on patient care.\n\nOur performance-based pricing is just 2.99% of the reimbursements we successfully collect.\n\nWe're offering a free, no-obligation 15-minute RCM analysis to identify potential revenue gaps and opportunities to increase collections.\n\nWould you be available for a quick call next week?\n\nYou can simply reply to this email or call me directly at 480-257-4833.\n\nI look forward to connecting with you.`,
      },
      {
        name: "Billing & A/R Review",
        subject: "Free Billing & A/R Review for {{practice_name}}",
        body: `Hi {{first_name}},\n\nI hope your week is going well. I'm reaching out because many practices leave 10%–15% of their earned revenue uncollected — usually hidden in aged A/R and denied claims.\n\nMy team at Star Billing handles end-to-end medical billing, A/R follow-up, and denial recovery on a performance basis. You only pay a small percentage of what we actually recover.\n\nWe would love to run a free, no-obligation billing and A/R review for {{practice_name}} to show you where revenue may be slipping through the cracks.\n\nWould a quick 15-minute call next week work for you? Just reply to this email or call me at 480-257-4833.\n\nBest regards,\nTed`,
      },
      {
        name: "RCM Introduction",
        subject: "Introducing Star Billing for {{practice_name}}",
        body: `Hi {{first_name}},\n\nMy name is Ted, and I lead Star Billing, an RCM company focused entirely on helping practices get paid faster.\n\nWe take the burden of billing, claims management, and follow-up off your team so they can focus on patient care. Our performance-based model means we only earn when you get paid — our fee is just 2.99% of the reimbursements we successfully collect.\n\nI'd like to introduce myself and learn a little about how {{practice_name}} currently handles its revenue cycle. Are you open to a brief, no-cost conversation next week?\n\nYou can reply to this email, or reach me directly at 480-257-4833.\n\nI look forward to connecting with you.\n\nBest,\nTed`,
      },
      {
        name: "Follow-up #1",
        subject: "Re: {{practice_name}} — quick follow-up",
        body: `Hi {{first_name}},\n\nI recently sent you a note about a free revenue cycle review for {{practice_name}} and wanted to make sure it didn't get buried.\n\nPractices we work with typically find 10–15% of their outstanding revenue that can still be recovered. We'd be happy to show you exactly where those opportunities are — no cost and no obligation.\n\nWould a quick call this week be convenient? Just reply to this email, or call me at 480-257-4833.\n\nThank you for your time,\nTed`,
      },
      {
        name: "Follow-up #2",
        subject: "{{practice_name}} — one last thought",
        body: `Hi {{first_name}},\n\nI know you're busy, so I'll keep this brief. This is my final follow-up regarding a free revenue cycle review for {{practice_name}}.\n\nOur performance-based pricing means there's zero risk: we only get paid a small percentage of the reimbursements we recover for you.\n\nIf a 15-minute call would be useful, simply reply to this email or call 480-257-4833. If now isn't the right time, no worries at all — I'll leave it here.\n\nWishing you and your team the best,\nTed`,
      },
    ];
    let created = 0;
    let skipped = 0;
    for (const t of templates) {
      const exists = await prisma.emailTemplate.findFirst({
        where: { userId: user.id, name: t.name },
      });
      if (exists) {
        skipped++;
        continue;
      }
      await prisma.emailTemplate.create({ data: { userId: user.id, ...t } });
      created++;
    }
    console.log(`Templates: ${created} created, ${skipped} already present.`);

  console.log(`Admin user ready: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });