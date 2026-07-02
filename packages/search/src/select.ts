/**
 * Env-driven provider selection. Unset → DuckDuckGo (zero key, zero setup —
 * works out of the .dmg). Brave/SearXNG are explicit opt-ins with BYO
 * credentials. Misconfiguration is a TYPED SearchConfigError, thrown here at
 * resolve time — never a silently-degraded provider.
 *
 * Resolution is two-phase so the serve wiring can seed the egress allowlist
 * with the provider's endpoints BEFORE the proxy (and its FetchLike) exists:
 *   resolveSearchConfig(env)          → { kind, endpointOrigins }   (pure)
 *   createSearchProvider(cfg, fetch)  → SearchProvider              (wired)
 */

import { BraveProvider } from "./brave.js";
import { DuckDuckGoProvider } from "./ddg.js";
import { SearchConfigError } from "./errors.js";
import { SearxngProvider } from "./searxng.js";
import type { FetchLike, SearchProvider } from "./types.js";

export interface SearchEnv {
  /** LATTICE_SEARCH_PROVIDER: "ddg" (default) | "brave" | "searxng". */
  readonly provider?: string | undefined;
  /** LATTICE_BRAVE_KEY — required for provider=brave. */
  readonly braveKey?: string | undefined;
  /** LATTICE_SEARXNG_URL — required for provider=searxng. */
  readonly searxngUrl?: string | undefined;
}

export type SearchKind = "ddg" | "brave" | "searxng";

export interface SearchConfig {
  readonly kind: SearchKind;
  /** Upstream origins → explicit egress-allowlist entries (never a bypass). */
  readonly endpointOrigins: ReadonlyArray<string>;
  readonly braveKey?: string;
  readonly searxngUrl?: string;
}

export function resolveSearchConfig(env: SearchEnv): SearchConfig {
  const kind = (env.provider ?? "ddg").toLowerCase() || "ddg";
  switch (kind) {
    case "ddg":
    case "duckduckgo":
      return { kind: "ddg", endpointOrigins: new DuckDuckGoProvider().endpointOrigins };
    case "brave": {
      if (!env.braveKey) throw new SearchConfigError("LATTICE_SEARCH_PROVIDER=brave requires LATTICE_BRAVE_KEY");
      // Constructing validates the key shape; endpoints are static.
      const p = new BraveProvider(env.braveKey);
      return { kind: "brave", endpointOrigins: p.endpointOrigins, braveKey: env.braveKey };
    }
    case "searxng": {
      if (!env.searxngUrl) throw new SearchConfigError("LATTICE_SEARCH_PROVIDER=searxng requires LATTICE_SEARXNG_URL");
      const p = new SearxngProvider(env.searxngUrl);
      return { kind: "searxng", endpointOrigins: p.endpointOrigins, searxngUrl: env.searxngUrl };
    }
    default:
      throw new SearchConfigError(`unknown LATTICE_SEARCH_PROVIDER "${env.provider}" (expected ddg | brave | searxng)`);
  }
}

export function createSearchProvider(cfg: SearchConfig, fetchFn?: FetchLike): SearchProvider {
  switch (cfg.kind) {
    case "ddg":
      return new DuckDuckGoProvider(fetchFn);
    case "brave":
      return new BraveProvider(cfg.braveKey ?? "", fetchFn);
    case "searxng":
      return new SearxngProvider(cfg.searxngUrl ?? "", fetchFn);
  }
}
