/** Chrome cookie import — decrypt round-trip + origin scoping (no real Chrome). */

import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { decryptCookieValue, hostMatches, importChromeCookies, listChromeProfiles } from "./chrome-import.js";

/** Encrypt a value the way Chrome does (v10: AES-128-CBC, IV = 16 spaces). */
function sealV10(plaintext: string, key: Buffer): string {
  const iv = Buffer.alloc(16, " ");
  const c = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from("v10"), ct]).toString("hex");
}

describe("chrome-import — cookie decryption", () => {
  const key = randomBytes(16);

  it("round-trips a v10-encrypted cookie value", () => {
    const enc = sealV10("session=abc123; secret", key);
    expect(decryptCookieValue(enc, key)).toBe("session=abc123; secret");
  });

  it("returns empty for an unencrypted / unknown prefix (skipped, not crashed)", () => {
    expect(decryptCookieValue(Buffer.from("plainvalue").toString("hex"), key)).toBe("");
  });

  it("returns empty for a wrong key rather than throwing", () => {
    const enc = sealV10("topsecret", key);
    expect(decryptCookieValue(enc, randomBytes(16))).toBe("");
  });
});

describe("chrome-import — origin scoping", () => {
  it("matches host_key against a host with and without leading dot", () => {
    expect(hostMatches(".example.com", "example.com")).toBe(true);
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches(".example.com", "mail.example.com")).toBe(true);
    expect(hostMatches(".other.com", "example.com")).toBe(false);
  });
});

describe("chrome-import — platform guard", () => {
  it("rejects non-macOS platforms with a clear error", () => {
    if (process.platform === "darwin") return; // can't simulate easily on mac
    expect(() => importChromeCookies("Default", ["https://x.com"])).toThrow(/macOS only/);
  });
});

describe("chrome-import — profile resolution", () => {
  it("lists profiles as {dir,name} without prompting the Keychain", () => {
    if (process.platform !== "darwin") return;
    const profiles = listChromeProfiles();
    expect(Array.isArray(profiles)).toBe(true);
    for (const p of profiles) {
      expect(typeof p.dir).toBe("string");
      expect(typeof p.name).toBe("string");
    }
  });

  it("errors on an unknown profile and names the available ones", () => {
    if (process.platform !== "darwin" || !listChromeProfiles().length) return;
    expect(() => importChromeCookies("NoSuchProfile-zzz", ["https://x.com"]))
      .toThrow(/not found\. Available profiles:/);
  });
});
