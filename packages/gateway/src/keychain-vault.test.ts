/** Apple Keychain provider shape (origin-lookup, no enumeration). */

import { describe, it, expect } from "vitest";
import { keychainProvider } from "./keychain-vault.js";

describe("keychain-vault — provider shape", () => {
  it("is an origin-lookup provider (no listLogins)", () => {
    const p = keychainProvider();
    expect(p.id).toBe("keychain");
    expect(p.prefix).toBe("kc");
    expect(p.needsSession).toBe(false);
    expect(p.listLogins).toBeUndefined();      // not enumerable
    expect(typeof p.findByOrigin).toBe("function");
  });

  it("status() surfaces the login-keychain-only limitation", () => {
    const s = keychainProvider().status();
    expect(s.available).toBe(true); // `security` ships with macOS
    expect(s.detail).toMatch(/login keychain only/i);
  });

  it("findByOrigin returns [] for a host with no stored internet-password", () => {
    // A host that won't exist in the login keychain on a test machine.
    const matches = keychainProvider().findByOrigin!("https://no-such-host.invalid");
    expect(matches).toEqual([]);
  });
});
