import { describe, it, expect } from "vitest";
import {
  personalize,
  assertOnlySupportedVariables,
  findUnresolvedVariables,
  validateTemplateContent,
  PREVIEW_LEAD,
} from "@/lib/personalization";

describe("personalize", () => {
  it("replaces all supported variables", () => {
    const out = personalize(
      "Hi {{first_name}} {{last_name}} at {{practice_name}} ({{email}})",
      { first_name: "Alex", last_name: "Rivera", email: "a@example.com", practice_name: "Green Valley" },
    );
    expect(out).toBe("Hi Alex Rivera at Green Valley (a@example.com)");
  });

  it("is case-insensitive on variable names", () => {
    const out = personalize("Hi {{FIRST_NAME}}", { first_name: "Alex" });
    expect(out).toBe("Hi Alex");
  });

  it("uses fallback for missing values", () => {
    const out = personalize("Hi {{first_name}}", { practice_name: "X" }, "friend");
    expect(out).toBe("Hi friend");
  });

  it("handles repeated variables", () => {
    const out = personalize("{{first_name}} + {{first_name}}", { first_name: "A" });
    expect(out).toBe("A + A");
  });
});

describe("personalize with missing optional lead fields", () => {
  it("TEST 12: missing first name does not crash and resolves to empty", () => {
    // An email-only lead has no name/company data at all.
    const values = { email: "john@example.com" };
    expect(() => personalize("Hi {{first_name}},", values)).not.toThrow();
    expect(personalize("Hi {{first_name}},", values)).toBe("Hi ,");
    expect(personalize("Hello {{first_name}} {{last_name}} at {{practice_name}}", values)).toBe(
      "Hello   at ",
    );
    // An explicitly empty string behaves exactly like a missing value.
    expect(personalize("Hi {{first_name}}", { first_name: "" })).toBe("Hi ");
    expect(personalize("Hi {{first_name}}", { first_name: "" }, "friend")).toBe("Hi friend");
    // The subject filler is safe too (identical substitution path).
    expect(personalize("Follow-up for {{first_name}}", values).trim()).toBe("Follow-up for");
  });
});

describe("assertOnlySupportedVariables", () => {
  it("accepts supported variables", () => {
    expect(() => assertOnlySupportedVariables("Hi {{first_name}} {{practice_name}}")).not.toThrow();
  });

  it("rejects unknown variables", () => {
    expect(() => assertOnlySupportedVariables("{{email_address}}")).toThrow(/Unsupported template variable/);
  });
});

describe("findUnresolvedVariables", () => {
  it("returns empty for fully-substituted text", () => {
    const substituted = personalize("Hi {{first_name}} at {{practice_name}}", PREVIEW_LEAD);
    expect(findUnresolvedVariables(substituted)).toEqual([]);
  });

  it("finds unknown variables the substitution leaves behind", () => {
    expect(findUnresolvedVariables("Hi {{firstname}}")).toEqual(["{{firstname}}"]);
    expect(findUnresolvedVariables("{{email_address}} + {{not_a_var}}")).toEqual([
      "{{email_address}}",
      "{{not_a_var}}",
    ]);
  });

  it("dedupes repeated tokens", () => {
    expect(findUnresolvedVariables("{{foo}} {{foo}}")).toEqual(["{{foo}}"]);
  });
});

describe("validateTemplateContent", () => {
  it("accepts clean content", () => {
    const res = validateTemplateContent("Hi {{first_name}}", "Body {{practice_name}}");
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("flags empty subject and body", () => {
    const res = validateTemplateContent("", "");
    expect(res.ok).toBe(false);
    expect(res.errors).toContain("Subject is required");
    expect(res.errors).toContain("Body is required");
  });

  it("flags unsupported variables", () => {
    const res = validateTemplateContent("Subject", "Hello {{firstname}}");
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("Unsupported template variable"))).toBe(true);
  });

  it("flags unbalanced braces", () => {
    const res = validateTemplateContent("Subject", "Hi {{first_name");
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unbalanced"))).toBe(true);
  });
});

describe("PREVIEW_LEAD", () => {
  it("fills every supported variable", () => {
    const out = personalize(
      "{{first_name}} {{last_name}} · {{practice_name}} · {{email}}",
      PREVIEW_LEAD,
    );
    expect(out).toBe("John Smith · ABC Medical Group · john@example.com");
  });
});