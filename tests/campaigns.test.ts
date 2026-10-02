import { describe, it, expect } from "vitest";
import { buildRecipientSeeds, estimateDuration, fillSubject } from "@/lib/campaigns";

const leads = [
  { id: "1", email: "a@example.com", firstName: "Alex", lastName: "Rivera", practiceName: "Green Valley" },
  { id: "2", email: "b@example.com", firstName: "Jamie", lastName: "Kim", practiceName: "Summit" },
  { id: "3", email: "c@example.com", firstName: "Priya", lastName: "Patel", practiceName: "Lakeside" },
];

describe("buildRecipientSeeds", () => {
  it("creates pending seeds for every lead", () => {
    const seeds = buildRecipientSeeds(leads, new Set());
    expect(seeds).toHaveLength(3);
    expect(seeds.every((s) => s.status === "pending")).toBe(true);
  });

  it("dedupes on normalized email", () => {
    const withDup = [{ ...leads[0] }, { id: "9", email: "A@EXAMPLE.COM", firstName: "Other", lastName: "", practiceName: "" }, ...leads.slice(1)];
    const seeds = buildRecipientSeeds(withDup, new Set());
    expect(seeds).toHaveLength(3);
  });

  it("seeds suppressed leads as skipped with a reason", () => {
    const suppressed = new Set(["b@example.com", "a@example.com"]);
    const seeds = buildRecipientSeeds(leads, suppressed);
    expect(seeds.find((s) => s.recipient === "b@example.com")?.status).toBe("skipped");
    expect(seeds.find((s) => s.recipient === "a@example.com")?.status).toBe("skipped");
    expect(seeds.find((s) => s.recipient === "c@example.com")?.status).toBe("pending");
    expect(seeds.filter((s) => s.status === "skipped").every((s) => s.lastError)).toBe(true);
  });
});

describe("fillSubject", () => {
  it("personalizes the subject line", () => {
    expect(
      fillSubject("Revenue review for {{practice_name}}", {
        first_name: leads[0].firstName,
        last_name: leads[0].lastName,
        email: leads[0].email,
        practice_name: leads[0].practiceName,
      }),
    ).toBe("Revenue review for Green Valley");
  });
});

describe("estimateDuration", () => {
  it("computes minutes", () => {
    expect(estimateDuration(10, 45)).toBe("8 min");
  });
  it("computes hours+minutes", () => {
    expect(estimateDuration(200, 45)).toBe("2 hr 30 min");
  });
  it("handles zero recipients", () => {
    expect(estimateDuration(0, 45)).toBe("0 min");
  });
});