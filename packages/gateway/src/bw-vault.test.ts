/** Bitwarden provider shape + status (no real `bw` required). */

import { describe, it, expect } from "vitest";
import { bitwardenProvider } from "./bw-vault.js";

describe("bw-vault — provider shape", () => {
  it("is an enumerable, session-requiring provider", () => {
    const p = bitwardenProvider();
    expect(p.id).toBe("bitwarden");
    expect(p.prefix).toBe("bw");
    expect(p.needsSession).toBe(true);
    expect(typeof p.listLogins).toBe("function");
    expect(typeof p.setSession).toBe("function");
  });

  it("status() reports availability without throwing", () => {
    const s = bitwardenProvider().status();
    expect(typeof s.available).toBe("boolean");
    expect(typeof s.ready).toBe("boolean");
    if (!s.available) {
      expect(s.ready).toBe(false);
      expect(s.detail).toMatch(/Bitwarden CLI/);
    }
  });
});
