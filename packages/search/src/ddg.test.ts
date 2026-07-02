import { describe, it, expect } from "vitest";
import { DuckDuckGoProvider, parseDdgHtml } from "./ddg.js";
import { SearchParseError, SearchUpstreamError } from "./errors.js";
import type { FetchLike } from "./types.js";

// A minimal html.duckduckgo.com results page (2 organic results, one with a
// /l/?uddg= redirect link, entity-encoded title, markup inside the snippet).
const FIXTURE = `
<div id="links" class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc123">Example &amp; Docs</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The <b>official</b> docs.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://direct.example.org/page">Direct Result</a>
      </h2>
      <a class="result__snippet" href="https://direct.example.org/page">Plain snippet text.</a>
    </div>
  </div>
</div>`;

function fakeFetch(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, ok: status >= 200 && status < 300, text: () => Promise.resolve(body) });
}

describe("DuckDuckGoProvider — parsing", () => {
  it("parses structured results and decodes uddg redirect links", () => {
    const results = parseDdgHtml(FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Example & Docs",
      url: "https://example.com/docs",
      snippet: "The official docs.",
      source: "ddg",
    });
    expect(results[1]!.url).toBe("https://direct.example.org/page");
  });

  it("search() clamps count and returns at most `count` results", async () => {
    const p = new DuckDuckGoProvider(fakeFetch(200, FIXTURE));
    const one = await p.search("example", { count: 1 });
    expect(one).toHaveLength(1);
  });

  it("a genuine zero-result page returns [] (not an error)", () => {
    expect(parseDdgHtml('<div id="links" class="results"><div class="no-results">No results.</div></div>')).toEqual([]);
  });
});

describe("DuckDuckGoProvider — typed failures (never silent empty)", () => {
  it("HTTP error → SearchUpstreamError with status", async () => {
    const p = new DuckDuckGoProvider(fakeFetch(503, "unavailable"));
    await expect(p.search("x")).rejects.toThrowError(SearchUpstreamError);
    await expect(p.search("x")).rejects.toThrow(/503/);
  });

  it("bot challenge page → SearchUpstreamError", async () => {
    const p = new DuckDuckGoProvider(fakeFetch(200, "<html><body>Our systems have detected an anomaly. Please solve this challenge.</body></html>"));
    await expect(p.search("x")).rejects.toThrowError(SearchUpstreamError);
  });

  it("non-results garbage → SearchParseError", async () => {
    const p = new DuckDuckGoProvider(fakeFetch(200, "<html><body>hello world</body></html>"));
    await expect(p.search("x")).rejects.toThrowError(SearchParseError);
  });

  it("network failure → SearchUpstreamError", async () => {
    const p = new DuckDuckGoProvider(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(p.search("x")).rejects.toThrowError(SearchUpstreamError);
  });
});
