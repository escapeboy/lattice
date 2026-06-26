/** CapabilityRegistry — per-origin caching with TTL. */

import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "./capability.js";

describe("CapabilityRegistry", () => {
  it("records and returns a capability for a URL's origin", () => {
    const r = new CapabilityRegistry();
    r.record("https://shop.example.com/cart", true, ["addToCart", "checkout"]);
    const c = r.get("https://shop.example.com/other");
    expect(c?.nativeMCP).toBe(true);
    expect(c?.actions).toEqual(["addToCart", "checkout"]);
  });

  it("caches by origin, not full URL", () => {
    const r = new CapabilityRegistry();
    r.record("https://a.example.com/p1", false);
    expect(r.get("https://a.example.com/p2")).toBeDefined();
    expect(r.get("https://b.example.com/p1")).toBeUndefined();
  });

  it("expires a stale probe past its TTL", () => {
    const r = new CapabilityRegistry(1000);
    r.record("https://x.com/a", true, [], 10_000);
    expect(r.get("https://x.com/a", 10_500)).toBeDefined();
    expect(r.get("https://x.com/a", 11_001)).toBeUndefined();
  });

  it("treats schemeless contexts as a single empty origin", () => {
    const r = new CapabilityRegistry();
    r.record("data:text/html,<h1>x</h1>", false);
    expect(r.get("about:blank")).toBeDefined(); // both map to "" origin
  });

  it("list() returns every recorded origin", () => {
    const r = new CapabilityRegistry();
    r.record("https://a.com/", true);
    r.record("https://b.com/", false);
    expect(r.list().map((c) => c.origin).sort()).toEqual(["https://a.com", "https://b.com"]);
  });
});
