import { describe, it, expect } from "vitest";
import { isOwner } from "@/lib/auth";

const session = { sub: "user-1", email: "a@example.com", name: null };

describe("authorization ownership checks", () => {
  it("returns true for the owner", () => {
    expect(isOwner(session, "user-1")).toBe(true);
  });

  it("rejects cross-user access", () => {
    expect(isOwner(session, "user-2")).toBe(false);
  });

  it("rejects anonymous sessions", () => {
    expect(isOwner(null, "user-1")).toBe(false);
  });
});