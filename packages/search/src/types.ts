/**
 * @lattice/search — provider-pluggable web search primitive.
 *
 * GOVERNANCE POSTURE (why this package is shaped the way it is):
 *   - Results are THIRD-PARTY CONTROLLED CONTENT. The gateway taints them by
 *     construction (same layer as page content) — a result is data, never an
 *     instruction, and cannot be promoted into an operator write.
 *   - Provider requests are OUTBOUND TRAFFIC. They take a FetchLike so the
 *     serve wiring can route them through the egress proxy (the same
 *     chokepoint as browser traffic) instead of an ungoverned direct fetch.
 *   - Everything is TS in the single bun binary: zero Docker, zero sidecar,
 *     zero Python (ADR 0003). The default provider (DuckDuckGo) needs no key.
 */

/** One structured search result. All content fields are third-party data. */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Which provider produced it ("ddg" | "brave" | "searxng"). */
  readonly source: string;
}

export interface SearchOptions {
  /** Max results to return (providers clamp to 1..10; default 5). */
  readonly count?: number;
}

export interface SearchProvider {
  /** Stable provider id, echoed as SearchResult.source. */
  readonly id: string;
  /** The upstream origins this provider talks to — each one is an explicit
   *  egress-allowlist entry when the firewall is active, never a bypass. */
  readonly endpointOrigins: ReadonlyArray<string>;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

/** The minimal response surface providers need (subset of WHATWG Response). */
export interface MinimalResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/**
 * The transport a provider fetches through. Global `fetch` satisfies it
 * (direct, dev-unrestricted); `proxiedFetch` satisfies it through the egress
 * proxy (firewalled). Injected so the wiring — not the provider — decides.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<MinimalResponse>;

export function clampCount(count: number | undefined, fallback = 5): number {
  if (count === undefined || !Number.isFinite(count)) return fallback;
  return Math.min(10, Math.max(1, Math.floor(count)));
}
