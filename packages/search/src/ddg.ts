/**
 * DuckDuckGoProvider — the DEFAULT search provider: zero API key, zero
 * sidecar, dependency-free (direct html.duckduckgo.com parsing, not
 * duck-duck-scrape — no dep bloat in the single bun binary).
 *
 * The HTML endpoint is the stable no-JS surface DDG serves to lynx/curl-class
 * clients. Results are parsed structurally (result__body blocks); redirect
 * links (`/l/?uddg=<encoded>`) are decoded to the real destination so the
 * agent sees the true target origin — the policy layer gates NAVIGATION to it
 * separately (search never auto-navigates).
 */

import { SearchParseError, SearchUpstreamError } from "./errors.js";
import { clampCount, type FetchLike, type SearchOptions, type SearchProvider, type SearchResult } from "./types.js";

const DDG_ORIGIN = "https://html.duckduckgo.com";

// A browser-class UA: the html endpoint serves plain results to it. The default
// undici/bun UA is served a JS challenge instead.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class DuckDuckGoProvider implements SearchProvider {
  readonly id = "ddg";
  readonly endpointOrigins = [DDG_ORIGIN];

  constructor(private readonly fetchFn: FetchLike = (url, init) => fetch(url, init)) {}

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const count = clampCount(opts?.count);
    const url = `${DDG_ORIGIN}/html/?q=${encodeURIComponent(query)}`;
    let res;
    try {
      res = await this.fetchFn(url, { headers: { "User-Agent": UA, "Accept": "text/html" } });
    } catch (e) {
      if (e instanceof Error && e.name.startsWith("Search")) throw e;
      throw new SearchUpstreamError(`duckduckgo request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new SearchUpstreamError(`duckduckgo answered HTTP ${res.status}`, res.status);
    const html = await res.text();
    return parseDdgHtml(html).slice(0, count);
  }
}

/** Parse the html.duckduckgo.com results page into structured results. */
export function parseDdgHtml(html: string): SearchResult[] {
  // Bot wall / challenge page: 200 with no result markup. Distinguish it from a
  // genuine zero-result page (which still renders the results container).
  if (!html.includes("result__body") && !html.includes("results")) {
    if (/anomaly|challenge|captcha/i.test(html)) {
      throw new SearchUpstreamError("duckduckgo served a bot challenge instead of results");
    }
    throw new SearchParseError("duckduckgo response contains no results markup");
  }

  const results: SearchResult[] = [];
  // Each organic result renders one result__body block; ads carry result--ad
  // on the outer div and are excluded by requiring the organic title anchor.
  const blocks = html.split(/class="[^"]*result__body/).slice(1);
  for (const block of blocks) {
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
      ?? /href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = decodeDdgHref(a[1] ?? "");
    if (!url) continue;
    const title = cleanText(a[2] ?? "");
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)
      ?? /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:div|td|span)>/.exec(block);
    const snippet = cleanText(sn?.[1] ?? "");
    if (title) results.push({ title, url, snippet, source: "ddg" });
  }
  return results;
}

/** DDG links are usually `//duckduckgo.com/l/?uddg=<encoded-real-url>&rut=…`. */
function decodeDdgHref(href: string): string | null {
  const unescaped = decodeEntities(href);
  try {
    const u = new URL(unescaped, DDG_ORIGIN);
    if (u.pathname === "/l/" || u.hostname === "duckduckgo.com") {
      const real = u.searchParams.get("uddg");
      if (real) return real;
    }
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    return null;
  } catch {
    return null;
  }
}

function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
