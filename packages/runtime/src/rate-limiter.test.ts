import { describe, it, expect } from "vitest";
import { OriginRateLimiter } from "./rate-limiter.js";

/**
 * A virtual clock + sleep so rate policy is tested deterministically without
 * real time. `sleep` advances the clock; concurrent acquires interleave through
 * the microtask queue but observe the same virtual `now`.
 */
function virtualTime() {
  let t = 0;
  const now = () => t;
  const sleep = (ms: number): Promise<void> => {
    t += ms;
    return Promise.resolve();
  };
  return { now, sleep, set: (v: number) => { t = v; } };
}

describe("OriginRateLimiter — per-origin spacing", () => {
  it("serializes requests to one origin at the configured rate (fan-out does not DDoS)", async () => {
    const vt = virtualTime();
    const rl = new OriginRateLimiter({ requestsPerSecond: 2 }, vt.now, vt.sleep); // 500ms apart
    const url = "https://site.example/a";

    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = vt.now();
      await rl.acquire(url);
      waits.push(vt.now() - before);
    }
    // First is immediate; each subsequent waits a full interval.
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBe(500);
    expect(waits[2]).toBe(500);
    expect(waits[3]).toBe(500);
  });

  it("different origins are independent (parallel, not serialized together)", async () => {
    const vt = virtualTime();
    const rl = new OriginRateLimiter({ requestsPerSecond: 1 }, vt.now, vt.sleep);
    await rl.acquire("https://a.example/x");
    const before = vt.now();
    await rl.acquire("https://b.example/y"); // different origin → no wait
    expect(vt.now() - before).toBe(0);
  });
});

describe("OriginRateLimiter — backoff on overload", () => {
  it("grows backoff exponentially on 429 and clears it on success", () => {
    const rl = new OriginRateLimiter({ requestsPerSecond: 10, initialBackoffMs: 1000, maxBackoffMs: 8000 });
    const url = "https://busy.example/p";
    expect(rl.backoffFor(url)).toBe(0);
    rl.report(url, 429);
    expect(rl.backoffFor(url)).toBe(1000);
    rl.report(url, 429);
    expect(rl.backoffFor(url)).toBe(2000);
    rl.report(url, 503);
    expect(rl.backoffFor(url)).toBe(4000);
    rl.report(url, 200); // recovered
    expect(rl.backoffFor(url)).toBe(0);
  });

  it("caps backoff at maxBackoffMs", () => {
    const rl = new OriginRateLimiter({ requestsPerSecond: 10, initialBackoffMs: 1000, maxBackoffMs: 3000 });
    const url = "https://busy.example/p";
    for (let i = 0; i < 10; i++) rl.report(url, 429);
    expect(rl.backoffFor(url)).toBe(3000);
  });

  it("a 429 delays the NEXT acquire by the backoff", async () => {
    const vt = virtualTime();
    const rl = new OriginRateLimiter({ requestsPerSecond: 100, initialBackoffMs: 2000 }, vt.now, vt.sleep);
    const url = "https://busy.example/p";
    await rl.acquire(url);
    rl.report(url, 429);
    const before = vt.now();
    await rl.acquire(url);
    expect(vt.now() - before).toBeGreaterThanOrEqual(2000);
  });
});

describe("OriginRateLimiter — policy override + robots.txt", () => {
  it("per-origin rps override changes the interval for just that origin", async () => {
    const vt = virtualTime();
    const rl = new OriginRateLimiter(
      { requestsPerSecond: 10, perOrigin: { "https://slow.example": 1 } }, // 1000ms apart
      vt.now,
      vt.sleep,
    );
    await rl.acquire("https://slow.example/a");
    const before = vt.now();
    await rl.acquire("https://slow.example/b");
    expect(vt.now() - before).toBe(1000);
  });

  it("robots.txt crawl-delay acts as a floor on the interval", async () => {
    const vt = virtualTime();
    const rl = new OriginRateLimiter({ requestsPerSecond: 100 }, vt.now, vt.sleep); // 10ms default
    rl.setCrawlDelay("https://polite.example", 5); // 5s floor
    await rl.acquire("https://polite.example/a");
    const before = vt.now();
    await rl.acquire("https://polite.example/b");
    expect(vt.now() - before).toBe(5000);
  });
});
