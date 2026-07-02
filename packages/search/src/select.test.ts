import { describe, it, expect } from "vitest";
import { resolveSearchConfig, createSearchProvider } from "./select.js";
import { SearchConfigError } from "./errors.js";

describe("provider selection — env-driven, DDG default", () => {
  it("unset provider → DuckDuckGo (zero key, zero setup)", () => {
    const cfg = resolveSearchConfig({});
    expect(cfg.kind).toBe("ddg");
    expect(cfg.endpointOrigins).toEqual(["https://html.duckduckgo.com"]);
    expect(createSearchProvider(cfg).id).toBe("ddg");
  });

  it("brave + key selects Brave with its endpoint origin", () => {
    const cfg = resolveSearchConfig({ provider: "brave", braveKey: "mock-brave-key" });
    expect(cfg.kind).toBe("brave");
    expect(cfg.endpointOrigins).toEqual(["https://api.search.brave.com"]);
    expect(createSearchProvider(cfg).id).toBe("brave");
  });

  it("brave WITHOUT key → typed SearchConfigError", () => {
    expect(() => resolveSearchConfig({ provider: "brave" })).toThrowError(SearchConfigError);
    expect(() => resolveSearchConfig({ provider: "brave" })).toThrow(/LATTICE_BRAVE_KEY/);
  });

  it("searxng + url selects SearXNG with the instance origin", () => {
    const cfg = resolveSearchConfig({ provider: "searxng", searxngUrl: "https://searx.internal.example:8443/base/" });
    expect(cfg.kind).toBe("searxng");
    expect(cfg.endpointOrigins).toEqual(["https://searx.internal.example:8443"]);
    expect(createSearchProvider(cfg).id).toBe("searxng");
  });

  it("searxng WITHOUT url / with a bad url → typed SearchConfigError", () => {
    expect(() => resolveSearchConfig({ provider: "searxng" })).toThrowError(SearchConfigError);
    expect(() => resolveSearchConfig({ provider: "searxng", searxngUrl: "not a url" })).toThrowError(SearchConfigError);
  });

  it("unknown provider → typed SearchConfigError", () => {
    expect(() => resolveSearchConfig({ provider: "google" })).toThrowError(SearchConfigError);
  });
});
