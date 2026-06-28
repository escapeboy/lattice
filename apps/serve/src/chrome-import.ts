/**
 * Human persona import — read + decrypt cookies from a real Chrome profile,
 * scoped to a set of origins. macOS only (Chrome encrypts cookies with a key in
 * the login Keychain). Reading the key via `security` prompts the human for
 * permission — exactly the human-in-the-loop gate the design requires.
 *
 * Returned cookie values are handed straight to the persona's encrypted state;
 * they never reach the model, the agent, or a trace. This module is invoked
 * ONLY from the control-plane (human) channel, never from an MCP tool.
 *
 * Cookie crypto (Chrome on macOS): key = PBKDF2-SHA1(keychainPassword,
 * "saltysalt", 1003, 16); value = AES-128-CBC, IV = 16 spaces, "v10" prefix.
 */

import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

function hostOf(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin.replace(/^https?:\/\//, "").split("/")[0] ?? origin; }
}

/** True if a Chrome host_key (".example.com" / "example.com") covers a host. */
export function hostMatches(hostKey: string, host: string): boolean {
  const hk = hostKey.replace(/^\./, "");
  return host === hk || host.endsWith("." + hk) || hk.endsWith("." + host);
}

function deriveKey(): Buffer {
  const pw = execFileSync("security", ["find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"], { encoding: "utf8" }).trim();
  return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

export function decryptCookieValue(encHex: string, key: Buffer): string {
  const buf = Buffer.from(encHex, "hex");
  if (buf.length <= 3) return "";
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return ""; // unencrypted/unknown — skip
  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  let out: Buffer;
  try {
    out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  } catch { return ""; }
  // Newer Chrome prepends a 32-byte SHA-256 domain hash to the plaintext; strip
  // leading control bytes (the hash) up to 32 if present.
  let start = 0;
  while (start < out.length && start < 32 && out[start]! < 0x20) start++;
  return out.subarray(start).toString("utf8");
}

const chromeRoot = (): string =>
  join(homedir(), "Library", "Application Support", "Google", "Chrome");

/** On-disk Chrome profiles that have a cookie store, with their display names. */
export function listChromeProfiles(): Array<{ dir: string; name: string }> {
  const root = chromeRoot();
  if (!existsSync(root)) return [];
  let displayNames: Record<string, string> = {};
  try {
    const local = JSON.parse(readFileSync(join(root, "Local State"), "utf8"));
    for (const [dir, info] of Object.entries(local?.profile?.info_cache ?? {})) {
      displayNames[dir] = (info as { name?: string })?.name ?? dir;
    }
  } catch { /* Local State missing/unreadable — fall back to dir names */ }
  const out: Array<{ dir: string; name: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(root, entry.name, "Cookies"))) continue;
    out.push({ dir: entry.name, name: displayNames[entry.name] ?? entry.name });
  }
  return out;
}

/** Resolve a user-typed profile (dir name OR display name, case-insensitive). */
function resolveProfileDir(profile: string): string | undefined {
  const profiles = listChromeProfiles();
  const want = profile.trim().toLowerCase();
  return profiles.find((p) => p.dir.toLowerCase() === want || p.name.toLowerCase() === want)?.dir
    ?? (existsSync(join(chromeRoot(), profile, "Cookies")) ? profile : undefined);
}

/**
 * Read cookies for the given origins from a Chrome profile and decrypt them.
 * @param profile Chrome profile dir name ("Default", "Profile 1") OR its display
 *   name as shown in Chrome's profile switcher ("Person 1", "Work"…).
 */
export function importChromeCookies(profile: string, origins: string[]): ImportedCookie[] {
  if (process.platform !== "darwin") {
    throw new Error("persona_import currently supports macOS only (Chrome cookie encryption is Keychain-bound).");
  }
  const dir = resolveProfileDir(profile);
  if (!dir) {
    const available = listChromeProfiles().map((p) => `"${p.dir}" (${p.name})`).join(", ") || "none found";
    throw new Error(`Chrome profile "${profile}" not found. Available profiles: ${available}.`);
  }
  const dbPath = join(chromeRoot(), dir, "Cookies");
  // Copy the DB so a running Chrome's lock doesn't block the read.
  const tmp = join(tmpdir(), `lattice-cookies-${Date.now()}.sqlite`);
  copyFileSync(dbPath, tmp);
  try {
    const rows = execFileSync("sqlite3", ["-noheader", "-separator", "\t", tmp,
      "SELECT host_key, name, hex(encrypted_value), path, is_secure, is_httponly, expires_utc FROM cookies;"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const key = deriveKey();
    const hosts = origins.map(hostOf);
    const out: ImportedCookie[] = [];
    for (const line of rows.split("\n")) {
      if (!line) continue;
      const [hostKey, name, encHex, path, isSecure, isHttpOnly, expiresUtc] = line.split("\t");
      if (!hostKey || !hosts.some((h) => hostMatches(hostKey, h))) continue;
      const value = decryptCookieValue(encHex ?? "", key);
      if (!value) continue;
      const exp = Number(expiresUtc ?? "0");
      out.push({
        name: name ?? "",
        value,
        domain: hostKey,
        path: path ?? "/",
        secure: isSecure === "1",
        httpOnly: isHttpOnly === "1",
        ...(exp > 0 ? { expires: Math.floor(exp / 1_000_000) - 11_644_473_600 } : {}),
      });
    }
    return out;
  } finally {
    rmSync(tmp, { force: true });
  }
}
