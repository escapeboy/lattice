/**
 * 1Password backing for the Vault — resolve secrets from 1Password on demand via
 * the `op` CLI instead of holding them at rest in Lattice's sealed store.
 *
 * The value flows engine→field exactly like a local vault secret: it is read
 * transiently during autofill and NEVER returned in any tool/model response.
 * `op`'s biometric / session unlock is the human-in-the-loop gate — the same
 * shape as the Keychain prompt on Chrome cookie import.
 */

import { execFileSync } from "node:child_process";
import type { CredentialProvider } from "./providers.js";

/** True if the `op` CLI is installed and on PATH. */
export function opAvailable(): boolean {
  try {
    execFileSync("op", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * True if an `op` account is configured and ready to use. We probe `op account
 * list`, NOT `op whoami`: under 1Password desktop-app integration `whoami`
 * reports "not signed in" even though item reads succeed (auth is per-command
 * via the app). `account list` is a local, non-prompting read — it tells us the
 * CLI is set up; the actual unlock happens (biometric) on the first real call.
 */
export function opSignedIn(): boolean {
  try {
    const out = execFileSync("op", ["account", "list", "--format", "json"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const accounts = JSON.parse(out) as unknown[];
    return Array.isArray(accounts) && accounts.length > 0;
  } catch {
    return false;
  }
}

export interface OpStatus {
  available: boolean;
  signedIn: boolean;
}

export function opStatus(): OpStatus {
  const available = opAvailable();
  return { available, signedIn: available ? opSignedIn() : false };
}

/** A Login item, sans secrets — what the agent/operator may enumerate. */
export interface OpLogin {
  id: string;
  title: string;
  /** Primary website origin (scheme + host), or "" when the item has no URL. */
  origin: string;
}

/** Resolved credential for one Login item (secrets — autofill-time only). */
export interface OpCredential {
  username: string;
  password: string;
  origin: string;
}

/** Normalise a 1Password URL field to an origin (scheme + host). */
function toOrigin(href: string | undefined): string {
  if (!href) return "";
  const raw = /^[a-z]+:\/\//i.test(href) ? href : `https://${href}`;
  try { return new URL(raw).origin; } catch { return ""; }
}

function primaryOrigin(urls?: Array<{ href?: string; primary?: boolean }>): string {
  if (!urls || !urls.length) return "";
  const chosen = urls.find((u) => u.primary) ?? urls[0];
  return toOrigin(chosen?.href);
}

function opJson(args: string[], maxBuffer = 16 * 1024 * 1024): unknown {
  try {
    const out = execFileSync("op", [...args, "--format", "json"], {
      encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(`1Password command failed (op ${args.join(" ")}) — is op installed and signed in? (${detail})`);
  }
}

/**
 * List all Login items (optionally scoped to a single vault) as id/title/origin
 * — NO secrets. Scope to a dedicated "Agent" vault to expose only those logins.
 */
export function opListLogins(vault?: string): OpLogin[] {
  const args = ["item", "list", "--categories", "Login"];
  if (vault) args.push("--vault", vault);
  const items = opJson(args) as Array<{ id: string; title?: string; urls?: Array<{ href?: string; primary?: boolean }> }>;
  return items.map((it) => ({ id: it.id, title: it.title ?? it.id, origin: primaryOrigin(it.urls) }));
}

/** 1Password as a pluggable credential provider (desktop-app / `op` CLI). */
export function onePasswordProvider(): CredentialProvider {
  return {
    id: "1password",
    label: "1Password",
    prefix: "op",
    needsSession: false,
    listLogins: (scope?: string) => opListLogins(scope),
    getLogin: (itemId: string) => opGetLogin(itemId),
    status: () => {
      const s = opStatus();
      return {
        available: s.available,
        ready: s.available && s.signedIn,
        detail: !s.available
          ? "1Password CLI (op) not found. Install it (brew install 1password-cli) and enable “Integrate with 1Password CLI” in the 1Password app’s Developer settings."
          : (!s.signedIn ? "Sign in to 1Password (unlock the app or run `op signin`)." : undefined),
      };
    },
  };
}

/** Resolve one Login item's username + password (secrets) and its origin. */
export function opGetLogin(id: string): OpCredential {
  const item = opJson(["item", "get", id]) as {
    fields?: Array<{ purpose?: string; label?: string; value?: string }>;
    urls?: Array<{ href?: string; primary?: boolean }>;
  };
  const fields = item.fields ?? [];
  const byPurpose = (p: string) => fields.find((f) => f.purpose === p)?.value;
  const byLabel = (l: string) => fields.find((f) => f.label?.toLowerCase() === l)?.value;
  return {
    username: byPurpose("USERNAME") ?? byLabel("username") ?? "",
    password: byPurpose("PASSWORD") ?? byLabel("password") ?? "",
    origin: primaryOrigin(item.urls),
  };
}
