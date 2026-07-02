/**
 * BraveProvider — opt-in, BYO API key (LATTICE_BRAVE_KEY). Cleaner index than
 * the scraped default; still zero sidecar (one HTTPS API call).
 */

import { SearchConfigError, SearchParseError, SearchUpstreamError } from "./errors.js";
import { clampCount, type FetchLike, type SearchOptions, type SearchProvider, type SearchResult } from "./types.js";

const BRAVE_ORIGIN = "https://api.search.brave.com";

interface BraveWebResult { title?: string; url?: string; description?: string }

export class BraveProvider implements SearchProvider {
  readonly id = "brave";
  readonly endpointOrigins = [BRAVE_ORIGIN];

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {
    if (!apiKey) throw new SearchConfigError("Brave provider requires LATTICE_BRAVE_KEY");
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const count = clampCount(opts?.count);
    const url = `${BRAVE_ORIGIN}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    let res;
    try {
      res = await this.fetchFn(url, {
        headers: { "Accept": "application/json", "X-Subscription-Token": this.apiKey },
      });
    } catch (e) {
      if (e instanceof Error && e.name.startsWith("Search")) throw e;
      throw new SearchUpstreamError(`brave request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new SearchUpstreamError(`brave answered HTTP ${res.status}`, res.status);
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new SearchParseError("brave response is not JSON");
    }
    const web = (body as { web?: { results?: BraveWebResult[] } }).web;
    if (!web || !Array.isArray(web.results)) throw new SearchParseError("brave response has no web.results");
    return web.results
      .filter((r): r is Required<BraveWebResult> => typeof r.url === "string" && typeof r.title === "string")
      .slice(0, count)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "", source: "brave" }));
  }
}
