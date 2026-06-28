/**
 * Apple Keychain backing via the `security` CLI — origin-lookup only (the
 * keychain can't be enumerated like a password manager). On the current site
 * we ask `security find-internet-password -s <host>` for a saved login.
 *
 * LIMITATION (surfaced in the UI): `security` reads the login keychain only.
 * Safari / iCloud Keychain web passwords live in a separate protected store
 * that command-line tools cannot read, so for most people this finds nothing.
 * It is useful only for internet passwords explicitly stored in the login
 * keychain (e.g. via `security add-internet-password` or some apps).
 */

import { spawnSync } from "node:child_process";
import type { CredentialProvider, ProviderLogin, ProviderCredential } from "./providers.js";

function hostOf(origin: string): string {
  try { return new URL(/^[a-z]+:\/\//i.test(origin) ? origin : `https://${origin}`).hostname; }
  catch { return origin.replace(/^https?:\/\//, "").split("/")[0] ?? origin; }
}

/** Run `security find-internet-password -s host -g`; null if no item. */
function findInternetPassword(host: string): { username: string; password: string } | null {
  const r = spawnSync("security", ["find-internet-password", "-s", host, "-g"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  // Username is an attribute on stdout; the password is printed on stderr by -g.
  const acct = /"acct"<blob>="([^"]*)"/.exec(r.stdout ?? "");
  const pw = /^password: "([^"]*)"/m.exec(r.stderr ?? "");
  if (!pw) return null;
  return { username: acct?.[1] ?? "", password: pw[1] ?? "" };
}

/** Apple Keychain as an origin-lookup credential provider. */
export function keychainProvider(): CredentialProvider {
  return {
    id: "keychain",
    label: "Apple Keychain",
    prefix: "kc",
    needsSession: false,
    findByOrigin: (origin: string): ProviderLogin[] => {
      const host = hostOf(origin);
      if (!host) return [];
      const hit = findInternetPassword(host);
      if (!hit) return [];
      const normOrigin = (() => { try { return new URL(`https://${host}`).origin; } catch { return origin; } })();
      return [{ id: host, title: host, origin: normOrigin }];
    },
    getLogin: (itemId: string): ProviderCredential => {
      const hit = findInternetPassword(itemId);
      if (!hit) throw new Error(`no Keychain internet-password for ${itemId}`);
      const origin = (() => { try { return new URL(`https://${itemId}`).origin; } catch { return itemId; } })();
      return { username: hit.username, password: hit.password, origin };
    },
    status: () => ({
      available: true, // `security` ships with macOS
      ready: true,
      detail: "Reads the login keychain only — Safari/iCloud Keychain passwords are not accessible to command-line tools, so this typically finds nothing.",
    }),
  };
}
