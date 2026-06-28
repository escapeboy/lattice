/**
 * Bitwarden backing via the `bw` CLI. Unlike 1Password's desktop-app
 * integration, `bw` needs a session token (from `bw unlock --raw`) for every
 * authenticated call — the operator supplies it once at connect time; it is
 * held in memory only and never reaches the model.
 */

import { execFileSync } from "node:child_process";
import type { CredentialProvider, ProviderLogin, ProviderCredential } from "./providers.js";

function toOrigin(href: string | undefined): string {
  if (!href) return "";
  const raw = /^[a-z]+:\/\//i.test(href) ? href : `https://${href}`;
  try { return new URL(raw).origin; } catch { return ""; }
}

function bwAvailable(): boolean {
  try { execFileSync("bw", ["--version"], { stdio: ["ignore", "pipe", "ignore"] }); return true; }
  catch { return false; }
}

function bwJson(args: string[], session: string | undefined, maxBuffer = 32 * 1024 * 1024): unknown {
  const full = session ? [...args, "--session", session] : args;
  try {
    const out = execFileSync("bw", [...full, "--raw"], { encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(`Bitwarden command failed (bw ${args.join(" ")}) — is bw installed and unlocked? (${detail})`);
  }
}

interface BwItem {
  id: string;
  name?: string;
  type?: number; // 1 = Login
  login?: { username?: string; password?: string; uris?: Array<{ uri?: string }> };
}

/** Bitwarden as a pluggable credential provider. */
export function bitwardenProvider(): CredentialProvider {
  let session: string | undefined;
  return {
    id: "bitwarden",
    label: "Bitwarden",
    prefix: "bw",
    needsSession: true,
    setSession: (token: string) => { session = token && token.trim() ? token.trim() : undefined; },
    listLogins: (scope?: string): ProviderLogin[] => {
      const args = scope ? ["list", "items", "--folderid", scope] : ["list", "items"];
      const items = bwJson(args, session) as BwItem[];
      return items
        .filter((it) => it.type === 1 && it.login)
        .map((it) => ({ id: it.id, title: it.name ?? it.id, origin: toOrigin(it.login?.uris?.[0]?.uri) }));
    },
    getLogin: (itemId: string): ProviderCredential => {
      const it = bwJson(["get", "item", itemId], session) as BwItem;
      return {
        username: it.login?.username ?? "",
        password: it.login?.password ?? "",
        origin: toOrigin(it.login?.uris?.[0]?.uri),
      };
    },
    status: () => {
      const available = bwAvailable();
      if (!available) {
        return { available: false, ready: false, detail: "Bitwarden CLI (bw) not found. Install it (brew install bitwarden-cli)." };
      }
      let state = "unknown";
      try { state = (bwJson(["status"], session) as { status?: string }).status ?? "unknown"; }
      catch { state = "unknown"; }
      const ready = state === "unlocked";
      const detail = ready ? undefined
        : state === "unauthenticated"
          ? "Not logged in. Run `bw login`, then `bw unlock --raw`, and paste the session token below."
          : "Locked. Run `bw unlock --raw` and paste the session token below.";
      return { available: true, ready, detail };
    },
  };
}
