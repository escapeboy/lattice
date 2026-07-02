/**
 * Search egress GOVERNANCE: provider requests pass through the Lattice egress
 * proxy (the same chokepoint as browser traffic) — never a direct fetch around
 * it. Allowed endpoints are explicit allowlist entries; a non-allowlisted
 * endpoint is refused BEFORE any bytes reach the network, as a typed
 * SearchEgressBlockedError. Proven against a REAL EgressProxy instance whose
 * decision log is asserted.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { EgressProxy, originAllowlist } from "@lattice/egress-proxy";
import { proxiedFetch } from "./proxied-fetch.js";
import { SearxngProvider } from "./searxng.js";
import { SearchEgressBlockedError } from "./errors.js";

let target: Server;
let targetOrigin: string;
let proxy: EgressProxy;
let proxyUrl: string;

beforeAll(async () => {
  // A local "search upstream" the provider will call over plain HTTP.
  target = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [{ title: "hit", url: "https://found.example/", content: "snippet" }] }));
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const addr = target.address();
  targetOrigin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  // Real egress proxy: ONLY the search endpoint origin is allowlisted.
  proxy = new EgressProxy({ allow: originAllowlist([], [targetOrigin]) });
  proxyUrl = (await proxy.start()).url;
});

afterAll(async () => {
  await proxy.stop();
  await new Promise<void>((r) => target.close(() => r()));
});

describe("search egress через firewall-а", () => {
  it("an allowlisted provider endpoint is reached THROUGH the proxy (decision logged)", async () => {
    const p = new SearxngProvider(targetOrigin, proxiedFetch(proxyUrl));
    const results = await p.search("q");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("hit");
    // The proof it did not bypass the chokepoint: the proxy DECIDED this request.
    const d = proxy.decisions.find((x) => x.origin === targetOrigin);
    expect(d).toBeDefined();
    expect(d!.allowed).toBe(true);
  });

  it("a NON-allowlisted endpoint is blocked by the proxy → typed SearchEgressBlockedError (HTTP)", async () => {
    const evil = new SearxngProvider("http://evil-upstream.example", proxiedFetch(proxyUrl));
    await expect(evil.search("q")).rejects.toThrowError(SearchEgressBlockedError);
    const d = proxy.decisions.find((x) => x.origin === "http://evil-upstream.example");
    expect(d).toBeDefined();
    expect(d!.allowed).toBe(false);
  });

  it("a NON-allowlisted HTTPS endpoint is refused at CONNECT (no TLS bytes leave) → typed error", async () => {
    const evil = new SearxngProvider("https://evil-upstream.example", proxiedFetch(proxyUrl));
    await expect(evil.search("q")).rejects.toThrowError(SearchEgressBlockedError);
    const d = proxy.decisions.find((x) => x.origin === "https://evil-upstream.example" && x.method === "connect");
    expect(d).toBeDefined();
    expect(d!.allowed).toBe(false);
  });
});
