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
import { onePasswordProvider } from "./op-vault.js";
import { bitwardenProvider } from "./bw-vault.js";
import { keychainProvider } from "./keychain-vault.js";
import type { CredentialProvider, ProviderLogin } from "./providers.js";

/** Public (secret-free) credential shape returned to the operator/agent.
 *  `source` is "local" for a stored secret, or a provider id ("1password",
 *  "bitwarden", "keychain") for a manager-backed credential. */
export interface PublicEntry {
  id: string;
  label: string;
  origin: string;
  username: string;
  source: string;
}

/** Live connection state for one credential provider. */
interface ProviderState {
  impl: CredentialProvider;
  connected: boolean;
  scope: string | undefined;
  cache: { at: number; logins: ProviderLogin[] } | null;
}

/** One row of `providerStatus()` — provider availability + connection. */
export interface ProviderStatusRow {
  id: string;
  label: string;
  needsSession: boolean;
  available: boolean;
  ready: boolean;
  detail?: string;
  connected: boolean;
  scope?: string;
  /** Cached login count; -1 for origin-lookup providers; 0 when disconnected. */
  logins: number;
}

/** Normalise an origin/URL to scheme+host for matching ("" stays ""). */
function normOrigin(origin: string): string {
  if (!origin) return "";
  const raw = /^[a-z]+:\/\//i.test(origin) ? origin : `https://${origin}`;
  try { return new URL(raw).origin.toLowerCase(); } catch { return origin.toLowerCase(); }
}

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

  // Pluggable credential providers (1Password, Bitwarden, Apple Keychain),
  // keyed by provider id. Connection state is operator-set and in-memory.
  private readonly providers = new Map<string, ProviderState>();
  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * @param keyHex 64-char hex (exactly 32 bytes). Omitted → a random key is
   *   generated (in-memory only; a restart loses it — fine for dev/tests, but
   *   NOT valid with a persistence `path`). A non-hex/short value is rejected
   *   rather than weakly derived — there is no passphrase KDF here.
   * @param path  optional JSON file the sealed store persists to (mode 0600).
   * @param opts  injection seam for tests: override the `providers` list
   *   (default: the real 1Password / Bitwarden / Apple Keychain providers).
   */
  constructor(
    keyHex?: string,
    path?: string,
    opts?: { providers?: CredentialProvider[] },
  ) {
    if (path && !keyHex) {
      throw new Error("A persistent vault requires LATTICE_VAULT_KEY (64-char hex); refusing to use an ephemeral key that would strand the stored credentials.");
    }
    this.key = keyHex ? deriveKey(keyHex) : randomBytes(32);
    this.path = path;
    const impls = opts?.providers ?? [onePasswordProvider(), bitwardenProvider(), keychainProvider()];
    for (const impl of impls) this.providers.set(impl.id, { impl, connected: false, scope: undefined, cache: null });
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as SealedEntry[];
      for (const e of raw) this.entries.set(e.id, e);
    }
  }

  /**
   * Connect a credential provider as a source. For enumerable providers this
   * lists the logins once (validating the provider is usable) and caches them;
   * for origin-lookup providers (Keychain) it just marks the connection live.
   * @param opts.scope   provider-specific scope (1Password vault, Bitwarden folder).
   * @param opts.session session token for providers that need one (Bitwarden).
   */
  connectProvider(id: string, opts?: { scope?: string; session?: string }): { logins: number } {
    const state = this.providers.get(id);
    if (!state) throw new Error(`unknown credential provider: ${id}`);
    const scope = opts?.scope && opts.scope.trim() ? opts.scope.trim() : undefined;
    if (state.impl.needsSession && opts?.session) state.impl.setSession?.(opts.session);
    state.scope = scope;
    if (state.impl.listLogins) {
      const logins = state.impl.listLogins(scope); // throws if provider is unavailable
      state.cache = { at: nowMs(), logins };
      state.connected = true;
      return { logins: logins.length };
    }
    // Origin-lookup provider (no enumeration): just go live.
    state.cache = null;
    state.connected = true;
    return { logins: -1 };
  }

  disconnectProvider(id: string): void {
    const state = this.providers.get(id);
    if (!state) return;
    state.connected = false;
    state.scope = undefined;
    state.cache = null;
  }

  /** Per-provider availability + connection status, for the operator UI. */
  providerStatus(): ProviderStatusRow[] {
    return Array.from(this.providers.values()).map((s) => {
      let avail: { available: boolean; ready: boolean; detail?: string | undefined } = { available: false, ready: false };
      try { avail = s.impl.status(); } catch { /* probe threw → treat as unavailable */ }
      const row: ProviderStatusRow = {
        id: s.impl.id, label: s.impl.label, needsSession: s.impl.needsSession,
        available: avail.available, ready: avail.ready,
        connected: s.connected,
        logins: s.connected ? (s.impl.listLogins ? this.providerLogins(s).length : -1) : 0,
      };
      if (avail.detail) row.detail = avail.detail;
      if (s.scope) row.scope = s.scope;
      return row;
    });
  }

  /** Cached Login list (refreshed past the TTL) for an enumerable provider. */
  private providerLogins(state: ProviderState): ProviderLogin[] {
    if (!state.connected || !state.impl.listLogins) return [];
    if (!state.cache || nowMs() - state.cache.at > Vault.CACHE_TTL_MS) {
      state.cache = { at: nowMs(), logins: state.impl.listLogins(state.scope) };
    }
    return state.cache.logins;
  }

  /** Resolve a virtual `<prefix>:<itemId>` id back to its provider + item. */
  private route(id: string): { state: ProviderState; itemId: string } | undefined {
    const i = id.indexOf(":");
    if (i < 0) return undefined;
    const prefix = id.slice(0, i);
    const itemId = id.slice(i + 1);
    for (const state of this.providers.values()) {
      if (state.impl.prefix === prefix) return state.connected ? { state, itemId } : undefined;
    }
    return undefined;
  }

  store(label: string, origin: string, username: string, password: string): VaultStoreResult {
    const id = randomUUID();
    this.entries.set(id, { id, label, origin, username, ...this.seal(password) });
    this.persist();
    return { id };
  }

  /**
   * STORED entries WITHOUT secrets — for ID resolution and the operator surface.
   * Does NOT include connected providers' logins: a manager can hold thousands,
   * so they're discovered per-page via `findByOrigin`, not enumerated wholesale.
   */
  listPublic(): Array<PublicEntry> {
    return Array.from(this.entries.values()).map(({ id, label, origin, username }) => ({
      id, label, origin, username, source: "local",
    }));
  }

  /**
   * Credentials usable on `origin`: stored entries bound to it PLUS, for every
   * connected provider, the logins whose website matches — each as a virtual
   * `<prefix>:<itemId>` entry. This is how the agent finds a credential for the
   * page it's on without enumerating the whole vault.
   */
  findByOrigin(origin: string): Array<PublicEntry> {
    const want = normOrigin(origin);
    const out: PublicEntry[] = this.listPublic().filter((e) => normOrigin(e.origin) === want);
    for (const state of this.providers.values()) {
      if (!state.connected) continue;
      // Origin-lookup providers (Keychain) query directly; enumerable providers
      // filter their cached list.
      const matches = state.impl.findByOrigin
        ? state.impl.findByOrigin(origin)
        : this.providerLogins(state).filter((l) => normOrigin(l.origin) === want);
      for (const l of matches) {
        out.push({ id: `${state.impl.prefix}:${l.id}`, label: l.title, origin: l.origin, username: "", source: state.impl.id });
      }
    }
    return out;
  }

  getPassword(id: string): string | undefined {
    const r = this.route(id);
    if (r) return r.state.impl.getLogin(r.itemId).password;
    const e = this.entries.get(id);
    return e ? this.open(e) : undefined;
  }

  getUsername(id: string): string | undefined {
    const r = this.route(id);
    if (r) return r.state.impl.getLogin(r.itemId).username;
    return this.entries.get(id)?.username;
  }

  /** The origin a credential is bound to — autofill must match it (A5). */
  getOrigin(id: string): string | undefined {
    const r = this.route(id);
    if (r) {
      // Enumerable: read the cached login's origin (no shell-out). Origin-lookup
      // (Keychain): the itemId is the host, so resolve its origin directly.
      if (r.state.impl.listLogins) {
        return this.providerLogins(r.state).find((l) => l.id === r.itemId)?.origin || undefined;
      }
      return r.state.impl.getLogin(r.itemId).origin || undefined;
    }
    return this.entries.get(id)?.origin;
  }

  has(id: string): boolean {
    const r = this.route(id);
    if (r) {
      if (r.state.impl.listLogins) return this.providerLogins(r.state).some((l) => l.id === r.itemId);
      return true; // origin-lookup provider — validated at resolve time
    }
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

function nowMs(): number {
  return Date.now();
}

/** Require exactly 32 bytes of hex. No passphrase KDF — a weak passphrase run
 *  through a single hash is brute-forceable, so reject it outright. */
function deriveKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("LATTICE_VAULT_KEY must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32");
  }
  return Buffer.from(keyHex, "hex");
}
