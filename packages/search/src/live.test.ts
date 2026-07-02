/**
 * LIVE search tests (real network): gated behind LATTICE_LIVE_SEARCH=1, like
 * the engine live tests are gated behind LATTICE_LIVE_ENGINE.
 *
 *   1. DDG default: zero-key search returns real structured results.
 *   2. Search egress THROUGH a real EgressProxy (CONNECT tunnel) with the DDG
 *      endpoint allowlisted — the live proof that provider traffic rides the
 *      firewall chokepoint, HTTPS included.
 */

import { describe, it, expect } from "vitest";
import { EgressProxy, originAllowlist } from "@lattice/egress-proxy";
import { DuckDuckGoProvider } from "./ddg.js";
import { SearchUpstreamError } from "./errors.js";
import { proxiedFetch } from "./proxied-fetch.js";

const live = process.env["LATTICE_LIVE_SEARCH"] === "1";

describe.skipIf(!live)("LIVE DuckDuckGo (default provider, zero key)", () => {
  it("returns structured results for a real query", async () => {
    const p = new DuckDuckGoProvider();
    const results = await p.search("Anthropic Claude", { count: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.source).toBe("ddg");
    }
  }, 30_000);

  it("search egress rides a REAL egress proxy (HTTPS CONNECT decision logged)", async () => {
    const proxy = new EgressProxy({ allow: originAllowlist([], ["https://html.duckduckgo.com"]) });
    const { url } = await proxy.start();
    try {
      const p = new DuckDuckGoProvider(proxiedFetch(url));
      // DDG may throttle rapid repeat queries (202 challenge) — that is a typed
      // upstream failure, and the invariant under test here is the EGRESS PATH:
      // the request must have traversed the proxy and been decided there.
      const results = await p.search("Lattice governed browser", { count: 3 }).catch((e: unknown) => {
        if (e instanceof SearchUpstreamError) return null; // throttled — path still proven below
        throw e;
      });
      if (results) expect(results.length).toBeGreaterThan(0);
      const d = proxy.decisions.find((x) => x.origin === "https://html.duckduckgo.com" && x.method === "connect");
      expect(d).toBeDefined();
      expect(d!.allowed).toBe(true);
    } finally {
      await proxy.stop();
    }
  }, 30_000);
});
