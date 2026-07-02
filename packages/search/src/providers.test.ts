import { describe, it, expect } from "vitest";
import { BraveProvider } from "./brave.js";
import { SearxngProvider } from "./searxng.js";
import { SearchParseError, SearchUpstreamError } from "./errors.js";
import type { FetchLike } from "./types.js";

function recordingFetch(status: number, body: string) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, ...(init?.headers ? { headers: init.headers } : {}) });
    return Promise.resolve({ status, ok: status >= 200 && status < 300, text: () => Promise.resolve(body) });
  };
  return { calls, fetchFn };
}

describe("BraveProvider (opt-in, BYO key)", () => {
  it("sends the key as X-Subscription-Token and parses web.results", async () => {
    const body = JSON.stringify({ web: { results: [{ title: "T", url: "https://a.example/", description: "D" }] } });
    const { calls, fetchFn } = recordingFetch(200, body);
    const p = new BraveProvider("mock-brave-key", fetchFn);
    const results = await p.search("query text", { count: 3 });
    expect(results).toEqual([{ title: "T", url: "https://a.example/", snippet: "D", source: "brave" }]);
    expect(calls[0]!.url).toContain("https://api.search.brave.com/res/v1/web/search?q=query%20text&count=3");
    expect(calls[0]!.headers?.["X-Subscription-Token"]).toBe("mock-brave-key");
  });

  it("HTTP 401 → SearchUpstreamError; non-JSON → SearchParseError", async () => {
    await expect(new BraveProvider("k", recordingFetch(401, "{}").fetchFn).search("x")).rejects.toThrowError(SearchUpstreamError);
    await expect(new BraveProvider("k", recordingFetch(200, "<html>").fetchFn).search("x")).rejects.toThrowError(SearchParseError);
  });
});

describe("SearxngProvider (opt-in, BYO remote URL)", () => {
  it("queries <base>/search?format=json on the configured instance and parses results", async () => {
    const body = JSON.stringify({ results: [{ title: "T", url: "https://b.example/", content: "C" }] });
    const { calls, fetchFn } = recordingFetch(200, body);
    const p = new SearxngProvider("https://searx.self-hosted.example/", fetchFn);
    const results = await p.search("q");
    expect(results).toEqual([{ title: "T", url: "https://b.example/", snippet: "C", source: "searxng" }]);
    expect(calls[0]!.url).toBe("https://searx.self-hosted.example/search?q=q&format=json");
  });

  it("HTTP 500 → SearchUpstreamError; missing results array → SearchParseError", async () => {
    await expect(new SearxngProvider("https://s.example", recordingFetch(500, "").fetchFn).search("x")).rejects.toThrowError(SearchUpstreamError);
    await expect(new SearxngProvider("https://s.example", recordingFetch(200, "{}").fetchFn).search("x")).rejects.toThrowError(SearchParseError);
  });
});
