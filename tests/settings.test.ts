import { describe, it, expect } from "vitest";
import { DEFAULT_SEND_SETTINGS, isSendSettingsValueValid, type SendMode } from "@/lib/settings";

describe("DEFAULT_SEND_SETTINGS", () => {
  it("is conservative by default", () => {
    expect(DEFAULT_SEND_SETTINGS.dailySendLimit).toBeLessThanOrEqual(100);
    expect(DEFAULT_SEND_SETTINGS.messagesPerMinute).toBeLessThanOrEqual(5);
    expect(DEFAULT_SEND_SETTINGS.minDelaySeconds).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_SEND_SETTINGS.sendMode).toBe("live");
  });
});

describe("isSendSettingsValueValid", () => {
  const valid = {
    dailySendLimit: 100,
    messagesPerMinute: 3,
    minDelaySeconds: 20,
    maxDelaySeconds: 60,
    maxRetryAttempts: 5,
    baseRetryDelaySeconds: 60,
    maxRetryDelaySeconds: 3600,
  };

  it("accepts sane values", () => {
    for (const [key, value] of Object.entries(valid)) {
      expect(isSendSettingsValueValid(key as keyof typeof valid, value as number)).toBe(true);
    }
    expect(isSendSettingsValueValid("sendMode", "live")).toBe(true);
    expect(isSendSettingsValueValid("sendMode", "test")).toBe(true);
  });

  it("rejects out-of-range numbers", () => {
    expect(isSendSettingsValueValid("dailySendLimit", 0)).toBe(false);
    expect(isSendSettingsValueValid("dailySendLimit", 1_000_000)).toBe(false);
    expect(isSendSettingsValueValid("messagesPerMinute", 0)).toBe(false);
    expect(isSendSettingsValueValid("messagesPerMinute", 61)).toBe(false);
    expect(isSendSettingsValueValid("minDelaySeconds", 0)).toBe(false);
    expect(isSendSettingsValueValid("maxRetryAttempts", -1)).toBe(false);
    expect(isSendSettingsValueValid("baseRetryDelaySeconds", 0)).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(isSendSettingsValueValid("dailySendLimit", 12.5)).toBe(false);
  });

  it("validates send mode", () => {
    expect(isSendSettingsValueValid("sendMode", "test")).toBe(true);
    expect(isSendSettingsValueValid("sendMode", "nuke" as SendMode)).toBe(false);
  });
});