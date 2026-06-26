/**
 * In-process Vault — credentials never cross the model boundary.
 * Agents reference credentials by ID; the value flows engine→field only.
 *
 * At rest the password is encrypted with AES-256-GCM under a key supplied by
 * the operator (LATTICE_VAULT_KEY, 32-byte hex). Plaintext lives only in
 * memory and only transiently during getPassword(). When a `path` is given the
 * encrypted store is persisted there, so personas/credentials survive restarts.
 */

import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
   * @param keyHex 64-char hex (32 bytes). Omitted → a random key is generated
   *   (in-memory only; a process restart loses it — fine for dev/tests).
   * @param path  optional JSON file the sealed store persists to.
   */
  constructor(keyHex?: string, path?: string) {
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
    writeFileSync(this.path, JSON.stringify(Array.from(this.entries.values())), "utf8");
  }
}

/** Accept a 64-char hex key directly; otherwise derive 32 bytes via SHA-256. */
function deriveKey(keyHex: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(keyHex)) return Buffer.from(keyHex, "hex");
  return createHash("sha256").update(keyHex).digest();
}
