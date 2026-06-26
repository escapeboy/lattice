/** Vault — AES-256-GCM at rest + disk persistence. */

import { describe, it, expect, afterEach } from "vitest";
import { rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";

const KEY = "a".repeat(64); // 32-byte hex
const files: string[] = [];
function tmp(): string {
  const p = join(tmpdir(), `lattice-vault-${randomUUID()}.json`);
  files.push(p);
  return p;
}
afterEach(() => { for (const f of files.splice(0)) { if (existsSync(f)) rmSync(f); } });

describe("Vault — encryption at rest", () => {
  it("round-trips a password in memory", () => {
    const v = new Vault(KEY);
    const { id } = v.store("Bank", "https://bank.example", "alice", "TopSecret123");
    expect(v.getPassword(id)).toBe("TopSecret123");
    expect(v.getUsername(id)).toBe("alice");
  });

  it("never stores the plaintext password — on disk or in the serialized store", () => {
    const path = tmp();
    const v = new Vault(KEY, path);
    v.store("Bank", "https://bank.example", "alice", "PlaintextLeak42");
    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain("PlaintextLeak42");
    expect(bytes).toContain("alice"); // username is not secret
  });

  it("persists and reloads from disk with the same key", () => {
    const path = tmp();
    const v1 = new Vault(KEY, path);
    const { id } = v1.store("X", "https://x.com", "bob", "hunter2");
    const v2 = new Vault(KEY, path); // fresh instance, same file + key
    expect(v2.getPassword(id)).toBe("hunter2");
    expect(v2.listPublic().map((e) => e.username)).toContain("bob");
  });

  it("a wrong key cannot decrypt (GCM auth fails)", () => {
    const path = tmp();
    const { id } = new Vault(KEY, path).store("X", "https://x.com", "bob", "hunter2");
    const wrong = new Vault("b".repeat(64), path);
    expect(() => wrong.getPassword(id)).toThrow();
  });

  it("works without a key (random) and without a path (no persistence)", () => {
    const v = new Vault();
    const { id } = v.store("X", "https://x.com", "u", "p");
    expect(v.getPassword(id)).toBe("p");
  });

  it("persists the sealed store with owner-only (0600) permissions", () => {
    const path = tmp();
    new Vault(KEY, path).store("X", "https://x.com", "u", "p");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses a persistent vault without a key (no silent ephemeral key)", () => {
    expect(() => new Vault(undefined, tmp())).toThrow(/requires LATTICE_VAULT_KEY/);
  });

  it("rejects a non-hex / short key instead of weakly deriving it", () => {
    expect(() => new Vault("hunter2")).toThrow(/64 hex/);
    expect(() => new Vault("abc")).toThrow(/64 hex/);
  });

  it("each store uses a fresh IV (same password → different ciphertext)", () => {
    const path = tmp();
    const v = new Vault(KEY, path);
    v.store("A", "https://a.com", "u", "samepass");
    v.store("B", "https://b.com", "u", "samepass");
    const sealed = JSON.parse(readFileSync(path, "utf8")) as Array<{ ct: string; iv: string }>;
    expect(sealed[0]!.iv).not.toBe(sealed[1]!.iv);
    expect(sealed[0]!.ct).not.toBe(sealed[1]!.ct);
  });
});
