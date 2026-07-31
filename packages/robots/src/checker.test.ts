import { describe, it, expect, vi } from "vitest";
import { RobotsChecker, type RobotsFetch, type RobotsResponse } from "./checker.js";

function res(status: number, body = ""): RobotsResponse {
  return { status, ok: status >= 200 && status < 300, text: () => Promise.resolve(body) };
}

function fetchOf(map: Record<string, RobotsResponse | (() => Promise<RobotsResponse>)>): RobotsFetch {
  return (url) => {
    const entry = map[url];
    if (!entry) return Promise.resolve(res(404));
    return typeof entry === "function" ? entry() : Promise.resolve(entry);
  };
}

const ROBOTS = "https://example.com/robots.txt";

describe("RobotsChecker", () => {
  it("allows a path the robots.txt permits and blocks a disallowed one", async () => {
    const c = new RobotsChecker({ fetch: fetchOf({ [ROBOTS]: res(200, "User-agent: *\nDisallow: /private") }) });
    expect(await c.allowed("https://example.com/public")).toBe(true);
    expect(await c.allowed("https://example.com/private/x")).toBe(false);
  });

  it("treats 404 (no robots) as allow-all", async () => {
    const c = new RobotsChecker({ fetch: fetchOf({ [ROBOTS]: res(404) }) });
    expect(await c.allowed("https://example.com/anything")).toBe(true);
  });

  it("fail-open by default: a 5xx does not block navigation", async () => {
    const c = new RobotsChecker({ fetch: fetchOf({ [ROBOTS]: res(503) }) });
    expect(await c.allowed("https://example.com/x")).toBe(true);
  });

  it("fail-closed when configured: 5xx blocks", async () => {
    const c = new RobotsChecker({ failClosed: true, fetch: fetchOf({ [ROBOTS]: res(500) }) });
    expect(await c.allowed("https://example.com/x")).toBe(false);
  });

  it("fail-open on a network error (rejected fetch)", async () => {
    const c = new RobotsChecker({ fetch: () => Promise.reject(new Error("egress blocked")) });
    expect(await c.allowed("https://example.com/x")).toBe(true);
  });

  it("fail-closed on a network error when failClosed:true", async () => {
    const c = new RobotsChecker({ failClosed: true, fetch: () => Promise.reject(new Error("egress blocked")) });
    expect(await c.allowed("https://example.com/x")).toBe(false);
  });

  it("caches robots.txt per origin (one fetch across many checks)", async () => {
    const fetch = vi.fn(fetchOf({ [ROBOTS]: res(200, "User-agent: *\nDisallow: /no") }));
    const c = new RobotsChecker({ fetch });
    await c.allowed("https://example.com/a");
    await c.allowed("https://example.com/no");
    await c.allowed("https://example.com/b");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires (injectable clock)", async () => {
    const fetch = vi.fn(fetchOf({ [ROBOTS]: res(200, "User-agent: *\nDisallow: /no") }));
    let t = 1000;
    const c = new RobotsChecker({ fetch, cacheTtlMs: 100, now: () => t });
    await c.allowed("https://example.com/a");
    t += 200; // past the TTL
    await c.allowed("https://example.com/a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent first-hit fetches to one request", async () => {
    let calls = 0;
    const c = new RobotsChecker({
      fetch: () => { calls++; return Promise.resolve(res(200, "User-agent: *\nDisallow: /no")); },
    });
    const [a, b] = await Promise.all([
      c.allowed("https://example.com/no"),
      c.allowed("https://example.com/ok"),
    ]);
    expect(a).toBe(false);
    expect(b).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not gate non-http(s) or malformed URLs", async () => {
    const c = new RobotsChecker({ fetch: fetchOf({ [ROBOTS]: res(200, "User-agent: *\nDisallow: /") }) });
    expect(await c.allowed("about:blank")).toBe(true);
    expect(await c.allowed("not a url")).toBe(true);
  });

  it("scopes robots per origin", async () => {
    const c = new RobotsChecker({
      fetch: fetchOf({
        [ROBOTS]: res(200, "User-agent: *\nDisallow: /"),
        "https://other.com/robots.txt": res(200, "User-agent: *\nDisallow:"),
      }),
    });
    expect(await c.allowed("https://example.com/x")).toBe(false);
    expect(await c.allowed("https://other.com/x")).toBe(true);
  });
});
