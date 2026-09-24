import { describe, it, expect } from "vitest";
import {
  isValidPhoneNumber,
  normalizePhoneNumber,
  personalize,
} from "@/lib/8x8/sms";
import { mapX8StateToStatus } from "@/lib/8x8/types";
import { estimateSegments } from "@/components/sms/new-campaign-form";

describe("phone number validation", () => {
  it("accepts valid E.164 numbers", () => {
    expect(isValidPhoneNumber("+12025550123")).toBe(true);
    expect(isValidPhoneNumber("+6581968289")).toBe(true);
    expect(isValidPhoneNumber("12025550123")).toBe(true);
  });

  it("rejects invalid phone numbers", () => {
    expect(isValidPhoneNumber("")).toBe(false);
    expect(isValidPhoneNumber("12345")).toBe(false);
    expect(isValidPhoneNumber("not-a-phone")).toBe(false);
    expect(isValidPhoneNumber("+")).toBe(false);
    expect(isValidPhoneNumber("+0123456789")).toBe(false); // leading 0 not allowed after +
  });
});

describe("phone number normalization", () => {
  it("strips formatting characters", () => {
    expect(normalizePhoneNumber("(202) 555-0123")).toBe("+2025550123");
    expect(normalizePhoneNumber("+1 202 555 0123")).toBe("+12025550123");
  });

  it("adds + to digit-only input", () => {
    expect(normalizePhoneNumber("12025550123")).toBe("+12025550123");
  });
});

describe("personalization", () => {
  it("replaces {{name}} placeholders", () => {
    expect(personalize("Hi {{name}}, your bill is due", "Jane")).toBe(
      "Hi Jane, your bill is due",
    );
  });

  it("falls back to 'there' when name missing", () => {
    expect(personalize("Hi {{name}}!", null)).toBe("Hi there!");
    expect(personalize("Hi {{name}}!", "   ")).toBe("Hi there!");
  });
});

describe("DLR state mapping", () => {
  it("maps all documented 8x8 states to internal statuses", () => {
    expect(mapX8StateToStatus("delivered")).toBe("delivered");
    expect(mapX8StateToStatus("undelivered")).toBe("undelivered");
    expect(mapX8StateToStatus("rejected")).toBe("rejected");
    expect(mapX8StateToStatus("expired")).toBe("failed");
    expect(mapX8StateToStatus("deleted")).toBe("failed");
    expect(mapX8StateToStatus("queued")).toBe("queued");
    expect(mapX8StateToStatus("accepted")).toBe("queued");
    expect(mapX8StateToStatus("sent")).toBe("sent");
  });
});

describe("SMS segment estimation", () => {
  it("counts single GSM7 segment up to 160 chars", () => {
    const { segments, encoding } = estimateSegments("a".repeat(160));
    expect(segments).toBe(1);
    expect(encoding).toBe("GSM7");
  });

  it("counts multi-part GSM7 with 153-char parts", () => {
    expect(estimateSegments("a".repeat(161)).segments).toBe(2);
    expect(estimateSegments("a".repeat(306)).segments).toBe(2);
    expect(estimateSegments("a".repeat(307)).segments).toBe(3);
  });

  it("uses UCS2 (70/67) for non-GSM content like emoji", () => {
    expect(estimateSegments("😀".repeat(70)).segments).toBe(1);
    const two = estimateSegments("😀".repeat(71));
    expect(two.encoding).toBe("UCS2");
    expect(two.segments).toBe(2);
    expect(estimateSegments("héllo wörld").encoding).toBe("GSM7"); // é/ö are in GSM7
    expect(estimateSegments("こんにちは").encoding).toBe("UCS2");
  });
});
