/** Vault — AES-256-GCM at rest + disk persistence. */

import { describe, it, expect, afterEach } from "vitest";
import { rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import type { CredentialProvider } from "./providers.js";

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

describe("Vault — credential providers (connect whole manager)", () => {
  const logins = [
    { id: "abc", title: "GitHub", origin: "https://github.com" },
    { id: "def", title: "Reddit", origin: "https://reddit.com" },
  ];
  const secrets: Record<string, { username: string; password: string; origin: string }> = {
    abc: { username: "octocat", password: "gh-pw", origin: "https://github.com" },
    def: { username: "snoo", password: "rd-pw", origin: "https://reddit.com" },
  };
  // A fake enumerable provider (shaped like 1Password) — no shelling out.
  function fakeProvider(calls?: { list: number; get: string[] }): CredentialProvider {
    return {
      id: "1password", label: "1Password", prefix: "op", needsSession: false,
      listLogins: (scope?: string) => { if (calls) calls.list++; return scope === "Empty" ? [] : logins; },
      getLogin: (id: string) => { if (calls) calls.get.push(id); return secrets[id]!; },
      status: () => ({ available: true, ready: true }),
    };
  }
  // A fake origin-lookup provider (shaped like Apple Keychain).
  function fakeLookupProvider(): CredentialProvider {
    return {
      id: "keychain", label: "Apple Keychain", prefix: "kc", needsSession: false,
      findByOrigin: (origin: string) =>
        origin.includes("github.com") ? [{ id: "github.com", title: "github.com", origin: "https://github.com" }] : [],
      getLogin: () => ({ username: "kcuser", password: "kc-pw", origin: "https://github.com" }),
      status: () => ({ available: true, ready: true }),
    };
  }
  const mk = (calls?: { list: number; get: string[] }) =>
    new Vault(KEY, undefined, { providers: [fakeProvider(calls)] });

  it("does NOT dump the whole manager into listPublic — only stored entries", () => {
    const v = mk();
    const { logins: n } = v.connectProvider("1password");
    expect(n).toBe(2);
    expect(v.listPublic()).toHaveLength(0); // provider logins are NOT enumerated wholesale
    const st = v.providerStatus().find((p) => p.id === "1password")!;
    expect(st).toMatchObject({ connected: true, logins: 2, available: true, ready: true });
  });

  it("findByOrigin returns the matching Login as a virtual <prefix>: entry", () => {
    const v = mk();
    v.connectProvider("1password");
    const matches = v.findByOrigin("https://github.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: "op:abc", origin: "https://github.com", source: "1password" });
    expect(v.findByOrigin("https://github.com/")).toHaveLength(1); // origin normalised
    expect(v.findByOrigin("https://nomatch.com")).toHaveLength(0);
  });

  it("resolves username/password/origin for a virtual entry only at read time", () => {
    const v = mk();
    v.connectProvider("1password");
    expect(v.getUsername("op:abc")).toBe("octocat");
    expect(v.getPassword("op:abc")).toBe("gh-pw");
    expect(v.getOrigin("op:abc")).toBe("https://github.com"); // A5 origin-binding
    expect(v.has("op:def")).toBe(true);
    expect(v.has("op:zzz")).toBe(false);
  });

  it("does not resolve provider entries once disconnected", () => {
    const v = mk();
    v.connectProvider("1password");
    expect(v.findByOrigin("https://github.com")).toHaveLength(1);
    v.disconnectProvider("1password");
    expect(v.findByOrigin("https://github.com")).toHaveLength(0);
    expect(v.getPassword("op:abc")).toBeUndefined();
    expect(v.providerStatus().find((p) => p.id === "1password")!.connected).toBe(false);
  });

  it("scopes to a provider-specific scope", () => {
    const v = mk();
    const { logins: n } = v.connectProvider("1password", { scope: "Empty" });
    expect(n).toBe(0);
    expect(v.providerStatus().find((p) => p.id === "1password")!.scope).toBe("Empty");
  });

  it("caches the login list (no list call per lookup) within the TTL", () => {
    const calls = { list: 0, get: [] as string[] };
    const v = mk(calls);
    v.connectProvider("1password");       // 1 list call
    v.findByOrigin("https://github.com"); v.findByOrigin("https://reddit.com"); v.has("op:abc");
    expect(calls.list).toBe(1);   // served from cache
  });

  it("findByOrigin includes a matching local entry alongside provider matches", () => {
    const v = mk();
    v.store("Local GitHub", "https://github.com", "localuser", "p");
    v.connectProvider("1password");
    const matches = v.findByOrigin("https://github.com");
    expect(matches).toHaveLength(2);
    expect(matches.filter((e) => e.source === "local")).toHaveLength(1);
  });

  it("supports origin-lookup providers (no enumeration) via findByOrigin", () => {
    const v = new Vault(KEY, undefined, { providers: [fakeLookupProvider()] });
    const { logins: n } = v.connectProvider("keychain");
    expect(n).toBe(-1); // not enumerable
    const matches = v.findByOrigin("https://github.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: "kc:github.com", source: "keychain" });
    expect(v.getPassword("kc:github.com")).toBe("kc-pw");
    expect(v.findByOrigin("https://other.com")).toHaveLength(0);
  });

  it("aggregates matches across multiple connected providers", () => {
    const v = new Vault(KEY, undefined, { providers: [fakeProvider(), fakeLookupProvider()] });
    v.connectProvider("1password");
    v.connectProvider("keychain");
    const matches = v.findByOrigin("https://github.com");
    expect(matches.map((m) => m.source).sort()).toEqual(["1password", "keychain"]);
  });
});
