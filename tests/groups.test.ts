import { describe, it, expect } from "vitest";
import {
  checkGroupName,
  groupLeadWhere,
  normalizeGroupDescription,
  normalizeGroupName,
  GROUP_NAME_MAX,
} from "@/lib/groups";

describe("normalizeGroupName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeGroupName("  Dental   Practices  ")).toBe("Dental Practices");
  });

  it("leaves a clean name untouched", () => {
    expect(normalizeGroupName("Healthcare Prospects")).toBe("Healthcare Prospects");
  });

  it("collapses tabs and newlines too", () => {
    expect(normalizeGroupName("A\t\nB")).toBe("A B");
  });
});

describe("normalizeGroupDescription", () => {
  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeGroupDescription("")).toBeNull();
    expect(normalizeGroupDescription("   ")).toBeNull();
    expect(normalizeGroupDescription(null)).toBeNull();
    expect(normalizeGroupDescription(undefined)).toBeNull();
  });

  it("trims a real description", () => {
    expect(normalizeGroupDescription("  warm leads ")).toBe("warm leads");
  });
});

describe("checkGroupName", () => {
  it("rejects an empty name", () => {
    const r = checkGroupName("   ");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/required/i);
  });

  it("rejects a name longer than the cap", () => {
    const r = checkGroupName("x".repeat(GROUP_NAME_MAX + 1));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/characters or fewer/i);
  });

  it("accepts a name exactly at the cap", () => {
    const r = checkGroupName("x".repeat(GROUP_NAME_MAX));
    expect(r.ok).toBe(true);
  });

  it("accepts a new name and returns the normalized form", () => {
    const r = checkGroupName("  Insurance  Leads ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("Insurance Leads");
  });

  it("rejects an exact duplicate", () => {
    const r = checkGroupName("Dental Practices", ["Dental Practices"]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already exists/i);
  });

  it("rejects a duplicate that differs only by case or spacing", () => {
    expect(checkGroupName("dental practices", ["Dental  Practices"]).ok).toBe(false);
  });

  it("allows a name that is a prefix of an existing one", () => {
    expect(checkGroupName("Dental", ["Dental Practices"]).ok).toBe(true);
  });
});

describe("groupLeadWhere", () => {
  it("scopes to the group when a group id is given", () => {
    expect(groupLeadWhere("u1", "g1")).toEqual({
      userId: "u1",
      leadGroups: { some: { groupId: "g1" } },
    });
  });

  it("keeps the pre-Groups behaviour when there is no group", () => {
    // Backwards compatibility: an ungrouped campaign still targets every lead.
    expect(groupLeadWhere("u1", null)).toEqual({ userId: "u1" });
    expect(groupLeadWhere("u1", "")).toEqual({ userId: "u1" });
  });

  it("always pins the owner so a group cannot leak another user's leads", () => {
    const w = groupLeadWhere("u1", "g1");
    expect(w.userId).toBe("u1");
  });
});
