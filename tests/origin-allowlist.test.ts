import { describe, it, expect } from "vitest";
import { buildAllowedOrigins } from "@/lib/http";

const APP = "https://res-subjective-labeled-come.trycloudflare.com";

describe("buildAllowedOrigins", () => {
  it("always includes APP_URL even when the allowlist is empty", () => {
    const s = buildAllowedOrigins(APP, "");
    expect(Array.from(s)).toEqual([APP]);
  });

  it("adds explicitly allowed origins", () => {
    const s = buildAllowedOrigins(APP, "http://localhost:3010");
    expect(s.has(APP)).toBe(true);
    expect(s.has("http://localhost:3010")).toBe(true);
    expect(s.size).toBe(2);
  });

  it("supports a comma-separated list with stray whitespace", () => {
    const s = buildAllowedOrigins(APP, " http://localhost:3010 ,  http://192.168.1.5:3010 ,");
    expect(s.has("http://localhost:3010")).toBe(true);
    expect(s.has("http://192.168.1.5:3010")).toBe(true);
  });

  it("normalises trailing slashes and default ports", () => {
    const s = buildAllowedOrigins(APP, "http://localhost:3010/,http://LOCALHOST:3010");
    expect(s.has("http://localhost:3010")).toBe(true);
    // same origin expressed twice collapses to one entry
    expect(s.size).toBe(2);
  });

  it("distinguishes port and scheme, so a hostile origin is not accepted", () => {
    const s = buildAllowedOrigins(APP, "http://localhost:3010");
    expect(s.has("http://localhost:3011")).toBe(false);
    expect(s.has("https://localhost:3010")).toBe(false);
    expect(s.has("http://evil.example")).toBe(false);
  });

  it("ignores malformed entries instead of throwing", () => {
    const s = buildAllowedOrigins(APP, "not a url,://broken,http://localhost:3010");
    expect(s.has(APP)).toBe(true);
    expect(s.has("http://localhost:3010")).toBe(true);
    expect(s.size).toBe(2);
  });

  it("never allows the opaque 'null' origin, even if listed", () => {
    const s = buildAllowedOrigins(APP, "null,file://,data:");
    expect(s.has("null")).toBe(false);
    expect(Array.from(s)).toEqual([APP]);
  });
});
