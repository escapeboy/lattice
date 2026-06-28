/**
 * Credential-provider abstraction — a pluggable source of logins the agent can
 * autofill (1Password, Bitwarden, Apple Keychain, …). Every provider resolves
 * secrets engine→field only; values never reach the model. Matching is by the
 * login's own website (A5 origin-binding), so a credential is only ever typed
 * onto the site it belongs to.
 *
 * Providers are EITHER enumerable (list every login — 1Password, Bitwarden) OR
 * origin-lookup only (query by the current site — Apple Keychain, whose store
 * can't be listed). The Vault treats both uniformly via `findByOrigin`.
 */

/** A login sans secrets — safe to enumerate/return. */
export interface ProviderLogin {
  id: string;
  title: string;
  /** Website origin (scheme + host), or "" if the item has no URL. */
  origin: string;
}

/** A resolved credential (secrets) — autofill-time only. */
export interface ProviderCredential {
  username: string;
  password: string;
  origin: string;
}

/** Availability + auth readiness, for the operator UI. */
export interface ProviderAvailability {
  available: boolean;          // the CLI/tool is installed
  ready: boolean;              // installed AND authenticated/usable
  detail?: string | undefined; // human hint when not ready
}

export interface CredentialProvider {
  /** Stable key, e.g. "1password" | "bitwarden" | "keychain". */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** Virtual-entry id prefix ("op" | "bw" | "kc"). */
  readonly prefix: string;
  /** Whether this provider needs a session token to connect (Bitwarden). */
  readonly needsSession: boolean;
  /** Enumerable providers list every login (optionally scoped). */
  listLogins?(scope?: string): ProviderLogin[];
  /** Origin-lookup providers resolve by the current site instead of listing. */
  findByOrigin?(origin: string): ProviderLogin[];
  /** Resolve one login's secrets. */
  getLogin(itemId: string): ProviderCredential;
  /** Availability/auth probe. */
  status(): ProviderAvailability;
  /** Supply a session token (providers with needsSession). */
  setSession?(token: string): void;
}
