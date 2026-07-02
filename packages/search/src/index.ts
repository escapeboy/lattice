/**
 * @lattice/search — provider-pluggable web search (DDG default / Brave /
 * SearXNG), all TS in the single bun binary: zero Docker, zero sidecar.
 * Governance lives in the consumers: the gateway taints results by
 * construction; the serve wiring routes provider egress through the firewall.
 */

export type { SearchProvider, SearchResult, SearchOptions, FetchLike, MinimalResponse } from "./types.js";
export { clampCount } from "./types.js";
export {
  SearchError,
  SearchConfigError,
  SearchEgressBlockedError,
  SearchUpstreamError,
  SearchParseError,
  type SearchErrorCode,
} from "./errors.js";
export { DuckDuckGoProvider, parseDdgHtml } from "./ddg.js";
export { BraveProvider } from "./brave.js";
export { SearxngProvider } from "./searxng.js";
export { resolveSearchConfig, createSearchProvider, type SearchEnv, type SearchConfig, type SearchKind } from "./select.js";
export { proxiedFetch, type ProxiedFetchOptions } from "./proxied-fetch.js";
