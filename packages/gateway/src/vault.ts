/**
 * In-process Vault — credentials never cross the model boundary.
 * Agents reference credentials by ID; the value flows engine→field only.
 *
 * At rest the password is encrypted with AES-256-GCM under a key supplied by
 * the operator (LATTICE_VAULT_KEY, 32-byte hex). Plaintext lives only in
 * memory and only transiently during getPassword(). When a `path` is given the
 * encrypted store is persisted there, so personas/credentials survive restarts.
 */

import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

export interface VaultEntry {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  /** Password is stored but NEVER returned via any tool response. */
  readonly password: string;
}

export interface VaultStoreResult {
  id: string;
}

/** Encrypted-at-rest record shape (what lands on disk / in memory). */
interface SealedEntry {
  id: string;
  label: string;
  origin: string;
  username: string;
  iv: string;
  ct: string;
  tag: string;
}

export class Vault {
  private readonly entries = new Map<string, SealedEntry>();
  private readonly key: Buffer;
  private readonly path: string | undefined;

  /**
   * @param keyHex 64-char hex (exactly 32 bytes). Omitted → a random key is
   *   generated (in-memory only; a restart loses it — fine for dev/tests, but
   *   NOT valid with a persistence `path`). A non-hex/short value is rejected
   *   rather than weakly derived — there is no passphrase KDF here.
   * @param path  optional JSON file the sealed store persists to (mode 0600).
   */
  constructor(keyHex?: string, path?: string) {
    if (path && !keyHex) {
      throw new Error("A persistent vault requires LATTICE_VAULT_KEY (64-char hex); refusing to use an ephemeral key that would strand the stored credentials.");
    }
    this.key = keyHex ? deriveKey(keyHex) : randomBytes(32);
    this.path = path;
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as SealedEntry[];
      for (const e of raw) this.entries.set(e.id, e);
    }
  }

  store(label: string, origin: string, username: string, password: string): VaultStoreResult {
    const id = randomUUID();
    this.entries.set(id, { id, label, origin, username, ...this.seal(password) });
    this.persist();
    return { id };
  }

  /** Returns entry WITHOUT the password field — for ID resolution. */
  listPublic(): Array<{ id: string; label: string; origin: string; username: string }> {
    return Array.from(this.entries.values()).map(({ id, label, origin, username }) => ({
      id, label, origin, username,
    }));
  }

  getPassword(id: string): string | undefined {
    const e = this.entries.get(id);
    return e ? this.open(e) : undefined;
  }

  getUsername(id: string): string | undefined {
    return this.entries.get(id)?.username;
  }

  /** The origin a credential is bound to — autofill must match it (A5). */
  getOrigin(id: string): string | undefined {
    return this.entries.get(id)?.origin;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private seal(plaintext: string): { iv: string; ct: string; tag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), ct: ct.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
  }

  private open(e: SealedEntry): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "hex"));
    decipher.setAuthTag(Buffer.from(e.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(e.ct, "hex")), decipher.final()]).toString("utf8");
  }

  private persist(): void {
    if (!this.path) return;
    // 0600: the sealed store is owner-only. writeFileSync's mode does not
    // re-apply to an existing file, so chmod explicitly after the write.
    writeFileSync(this.path, JSON.stringify(Array.from(this.entries.values())), { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

/** Require exactly 32 bytes of hex. No passphrase KDF — a weak passphrase run
 *  through a single hash is brute-forceable, so reject it outright. */
function deriveKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("LATTICE_VAULT_KEY must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32");
  }
  return Buffer.from(keyHex, "hex");
}
