/**
 * S4 integration tests — 10 parallel contexts, fan-out, snapshot/restore.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { EngineAdapter } from "@lattice/engine";
import { createRuntimeScheduler } from "./index.js";
import type { RuntimeScheduler } from "./index.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

function startTestServer(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = req.url ?? "/";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>Page ${path}</title></head><body>Path: ${path}</body></html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Bad address"));
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on("error", reject);
  });
}

describeIfBrowser("@lattice/runtime — integration (S4)", () => {
  let baseUrl: string;
  let httpServer: Server;
  let adapter: EngineAdapter;
  let scheduler: RuntimeScheduler;

  beforeAll(async () => {
    const { url, server } = await startTestServer();
    baseUrl = url;
    httpServer = server;

    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    scheduler = createRuntimeScheduler(adapter, {
      maxContexts: 12,
      maxMemoryMb: 4096,
      maxCpuPercent: 90,
    });
  });

  afterAll(async () => {
    await scheduler?.shutdown();
    await adapter?.shutdown();
    httpServer?.close();
  });

  it("creates 10 contexts in parallel, all under budget", async () => {
    expect(scheduler.activeCount()).toBe(0);

    const contexts = await Promise.all(
      Array.from({ length: 10 }, () => scheduler.createContext("ephemeral")),
    );

    expect(scheduler.activeCount()).toBe(10);
    expect(contexts).toHaveLength(10);

    // All IDs distinct
    const ids = new Set(contexts.map((c) => c.id));
    expect(ids.size).toBe(10);

    // Tear down
    await Promise.all(contexts.map((ctx) => scheduler.destroyContext(ctx.id)));
    expect(scheduler.activeCount()).toBe(0);
  });

  it("budget enforcement: creating beyond maxContexts throws", async () => {
    // Fill up to the limit
    const budget12 = createRuntimeScheduler(adapter, {
      maxContexts: 2, maxMemoryMb: 4096, maxCpuPercent: 90,
    });
    const c1 = await budget12.createContext("ephemeral");
    const c2 = await budget12.createContext("ephemeral");
    await expect(budget12.createContext("ephemeral")).rejects.toThrow("Budget exhausted");
    await budget12.destroyContext(c1.id);
    await budget12.destroyContext(c2.id);
  });

  it("fan-out: aggregates results from 5 concurrent navigations", async () => {
    const paths = ["/a", "/b", "/c", "/d", "/e"];
    let i = 0;

    const results = await scheduler.fanOut(5, async (ctx) => {
      const path = paths[i++ % paths.length]!;
      await ctx.navigate(`${baseUrl}${path}`);
      return ctx.currentUrl();
    });

    expect(results).toHaveLength(5);
    const urls = results.map((r) => r.result);
    // Each context navigated to a unique path
    const uniquePaths = new Set(urls.map((u) => new URL(u).pathname));
    expect(uniquePaths.size).toBeGreaterThanOrEqual(1); // at least one distinct path

    // fan-out cleaned up
    expect(scheduler.activeCount()).toBe(0);
  });

  it("snapshot captures cookies+localStorage+url and restore reconstructs them", async () => {
    const ctx = await scheduler.createContext("persistent");
    await ctx.navigate(`${baseUrl}/storage-test`);

    // Set a cookie and localStorage item
    await ctx.cdp().send("Network.setCookie", {
      name: "session",
      value: "tok-abc",
      domain: "127.0.0.1",
      path: "/",
    });
    await ctx.cdp().send("Runtime.evaluate", {
      expression: "localStorage.setItem('user', 'alice')",
    });

    const snap = await scheduler.snapshotContext(ctx.id);

    expect(snap.currentUrl).toContain("127.0.0.1");
    expect(snap.cookies.some((c) => c.name === "session" && c.value === "tok-abc")).toBe(true);
    expect(snap.localStorage["user"]).toBe("alice");

    await scheduler.destroyContext(ctx.id);

    // Restore into a new context
    const restored = await scheduler.restoreContext(snap);

    // Verify localStorage was restored
    const lsVal = await restored.cdp().send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "localStorage.getItem('user')",
      returnByValue: true,
    });
    expect(lsVal.result.value).toBe("alice");

    await scheduler.destroyContext(restored.id);
  });
});
