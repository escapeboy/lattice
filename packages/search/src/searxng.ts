/**
 * SearxngProvider — opt-in, BYO remote instance URL (LATTICE_SEARXNG_URL).
 * For self-hosted SearXNG users: the instance runs WHEREVER the user hosts it
 * (remote), never as a bundled sidecar — the .dmg stays zero-friction
 * (ADR 0003: no Docker/Python/Redis in the desktop stack).
 */

import { SearchConfigError, SearchParseError, SearchUpstreamError } from "./errors.js";
import { clampCount, type FetchLike, type SearchOptions, type SearchProvider, type SearchResult } from "./types.js";

interface SearxngResult { title?: string; url?: string; content?: string }

export class SearxngProvider implements SearchProvider {
  readonly id = "searxng";
  readonly endpointOrigins: ReadonlyArray<string>;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {
    if (!baseUrl) throw new SearchConfigError("SearXNG provider requires LATTICE_SEARXNG_URL");
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new SearchConfigError(`LATTICE_SEARXNG_URL is not a valid URL: ${baseUrl}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new SearchConfigError(`LATTICE_SEARXNG_URL must be http(s), got ${u.protocol}`);
    }
    this.base = u.href.replace(/\/+$/, "");
    this.endpointOrigins = [u.origin];
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const count = clampCount(opts?.count);
    const url = `${this.base}/search?q=${encodeURIComponent(query)}&format=json`;
    let res;
    try {
      res = await this.fetchFn(url, { headers: { "Accept": "application/json" } });
    } catch (e) {
      if (e instanceof Error && e.name.startsWith("Search")) throw e;
      throw new SearchUpstreamError(`searxng request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new SearchUpstreamError(`searxng answered HTTP ${res.status}`, res.status);
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new SearchParseError("searxng response is not JSON (is the instance's json format enabled?)");
    }
    const results = (body as { results?: SearxngResult[] }).results;
    if (!Array.isArray(results)) throw new SearchParseError("searxng response has no results array");
    return results
      .filter((r): r is SearxngResult & { url: string; title: string } => typeof r.url === "string" && typeof r.title === "string")
      .slice(0, count)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "", source: "searxng" }));
  }
}
