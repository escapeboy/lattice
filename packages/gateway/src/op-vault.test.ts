/** 1Password provider shape + status probing (no real `op` required). */

import { describe, it, expect } from "vitest";
import { onePasswordProvider, opStatus } from "./op-vault.js";

describe("op-vault — provider shape", () => {
  it("exposes a 1Password credential provider with the expected identity", () => {
    const p = onePasswordProvider();
    expect(p.id).toBe("1password");
    expect(p.prefix).toBe("op");
    expect(p.needsSession).toBe(false);
    expect(typeof p.listLogins).toBe("function"); // enumerable
  });

  it("status() reports availability without throwing (op may or may not be installed)", () => {
    const s = onePasswordProvider().status();
    expect(typeof s.available).toBe("boolean");
    expect(typeof s.ready).toBe("boolean");
    if (!s.available) expect(s.ready).toBe(false); // can't be ready without the CLI
  });
});

describe("op-vault — status", () => {
  it("opStatus reports installed/signed-in flags without throwing", () => {
    const s = opStatus();
    expect(typeof s.available).toBe("boolean");
    expect(typeof s.signedIn).toBe("boolean");
    if (!s.available) expect(s.signedIn).toBe(false);
  });
});
