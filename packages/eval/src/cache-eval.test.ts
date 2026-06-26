/**
 * Cache eval (P2.2) — asserts the HONEST framing: the cache amortizes the warm
 * revisit but does NOT change the cold first-visit cost.
 */

import { describe, it, expect } from "vitest";
import { runCacheEval, formatCacheReport } from "./cache-eval.js";

describe("perception-cache eval — cold unchanged, warm amortized", () => {
  it("the cache does NOT make the cold first visit free — the base skeleton cost is still paid", () => {
    const r = runCacheEval();
    // A large fraction of the no-cache cold cost is still paid to learn the
    // skeleton; the cache is not a fix for the base cost.
    expect(r.coldWithCache).toBeGreaterThan(r.coldNoCache * 0.5);
  });

  it("the warm (revisit) cost is much lower with the cache than without (amortization)", () => {
    const r = runCacheEval();
    expect(r.warmWithCache).toBeLessThan(r.warmNoCache);
    expect(r.warmRatio).toBeLessThan(0.5); // a clear, reported amortization
  });

  it("the warm revisit is markedly cheaper than the cold first visit (skeleton not re-sent)", () => {
    const r = runCacheEval();
    expect(r.warmWithCache).toBeLessThan(r.coldWithCache);
  });

  it("the report keeps cold and warm as separate numbers (no misleading aggregate)", () => {
    const text = formatCacheReport(runCacheEval());
    expect(text).toContain("COLD");
    expect(text).toContain("WARM");
    expect(text).toContain("base cost");
    expect(text.toLowerCase()).toContain("amortization");
  });
});
