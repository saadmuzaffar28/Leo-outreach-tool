import { describe, it, expect } from "vitest";
import {
  snapshotFromTemplate,
  parseTemplateSnapshot,
  campaignTemplateSource,
  campaignTemplateName,
} from "@/lib/templates";

const baseTemplate = {
  name: "Revenue Cycle Review",
  subject: "Revenue Cycle Review",
  body: "Hi {{first_name}}!",
  useSignature: true,
  signatureOverride: "Leo Collins",
};

describe("snapshotFromTemplate", () => {
  it("normalizes a nullable signature override to a string", () => {
    expect(snapshotFromTemplate({ ...baseTemplate, signatureOverride: null })).toEqual({
      ...baseTemplate,
      signatureOverride: "",
    });
    expect(snapshotFromTemplate(baseTemplate).signatureOverride).toBe("Leo Collins");
  });
});

describe("parseTemplateSnapshot", () => {
  it("accepts a stored snapshot object", () => {
    const snap = parseTemplateSnapshot({ ...baseTemplate, signatureOverride: "" });
    expect(snap?.name).toBe("Revenue Cycle Review");
  });

  it("rejects null / undefined / malformed values", () => {
    expect(parseTemplateSnapshot(null)).toBeNull();
    expect(parseTemplateSnapshot(undefined)).toBeNull();
    expect(parseTemplateSnapshot({ name: "only a name" })).toBeNull();
    expect(parseTemplateSnapshot("not an object")).toBeNull();
  });
});

describe("campaignTemplateSource", () => {
  it("prefers the snapshot when present", () => {
    const out = campaignTemplateSource({
      template: baseTemplate,
      templateSnapshot: { ...baseTemplate, name: "Edited Later", subject: "New Subject" },
    });
    expect(out?.name).toBe("Edited Later");
    expect(out?.subject).toBe("New Subject");
  });

  it("falls back to the live template without a snapshot", () => {
    const out = campaignTemplateSource({ template: baseTemplate, templateSnapshot: null });
    expect(out?.body).toBe("Hi {{first_name}}!");
  });

  it("returns null when nothing is available", () => {
    expect(campaignTemplateSource({ template: null, templateSnapshot: null })).toBeNull();
  });
});

describe("campaignTemplateName", () => {
  it("uses the snapshot name when present", () => {
    expect(
      campaignTemplateName({ template: baseTemplate, templateSnapshot: { ...baseTemplate, name: "Copy A" } }),
    ).toBe("Copy A");
  });

  it("falls back to the live template name", () => {
    expect(campaignTemplateName({ template: baseTemplate, templateSnapshot: null })).toBe(
      "Revenue Cycle Review",
    );
  });

  it("handles no template at all", () => {
    expect(campaignTemplateName({ template: null, templateSnapshot: null })).toBeNull();
  });
});