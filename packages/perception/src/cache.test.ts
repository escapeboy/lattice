import { describe, it, expect } from "vitest";
import { PerceptionCache } from "./cache.js";
import { snapshotToIG } from "./from-snapshot.js";

function ig(tree: string) {
  return snapshotToIG({ url: "data:cache", refs: [], tree }, { tier: "L1" }).graph;
}

const PAGE = '- list "Items" [ref=e1]\n  - button "Save" [ref=e2]\n  - button "Cancel" [ref=e3]';

describe("PerceptionCache — per-origin amortization", () => {
  it("cold visit sends every node; warm identical revisit sends nothing", () => {
    const cache = new PerceptionCache();
    const g = ig(PAGE);
    const cold = cache.resolve("https://a.example", g);
    expect(cold.warm).toBe(false);
    expect(cold.sentNodes.length).toBe(g.nodes.size); // full skeleton

    const warm = cache.resolve("https://a.example", ig(PAGE)); // identical revisit
    expect(warm.warm).toBe(true);
    expect(warm.sentNodes.length).toBe(0); // nothing to re-send
  });

  it("warm revisit sends only the changed/new nodes", () => {
    const cache = new PerceptionCache();
    cache.resolve("https://a.example", ig(PAGE));
    // "Cancel" removed, a new "Delete" added; "Save" unchanged.
    const next = ig('- list "Items" [ref=e1]\n  - button "Save" [ref=e2]\n  - button "Delete" [ref=e3]');
    const warm = cache.resolve("https://a.example", next);
    const labels = warm.sentNodes.map((n) => n.label).sort();
    expect(labels).toEqual(["Delete"]); // only the new node
    expect(warm.removedIds.length).toBe(1); // Cancel dropped
  });

  it("a changed attribute on an existing id re-sends that node", () => {
    const cache = new PerceptionCache();
    cache.resolve("https://a.example", ig('- checkbox "Agree" [ref=e1]'));
    const toggled = cache.resolve("https://a.example", ig('- checkbox "Agree" [ref=e1] [checked]'));
    expect(toggled.sentNodes.map((n) => n.label)).toEqual(["Agree"]); // state changed → re-sent
  });

  it("origins are independent; invalidate forces a cold visit again", () => {
    const cache = new PerceptionCache();
    cache.resolve("https://a.example", ig(PAGE));
    expect(cache.resolve("https://b.example", ig(PAGE)).warm).toBe(false); // different origin = cold
    cache.invalidate("https://a.example");
    expect(cache.resolve("https://a.example", ig(PAGE)).warm).toBe(false); // re-cold after invalidate
  });

  it("does not strip taint-relevant identity — returns the original IGNodes", () => {
    const cache = new PerceptionCache();
    const g = ig(PAGE);
    const cold = cache.resolve("https://a.example", g);
    // The cache returns the SAME node objects the IG holds (taint is reasserted
    // downstream at the gateway, not the cache's concern).
    for (const n of cold.sentNodes) expect(g.nodes.get(n.id)).toBe(n);
  });
});
