/**
 * S1 integration tests — requires a Chromium-compatible browser.
 * Skipped automatically when no browser executable is found.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "./index.js";
import type { EngineAdapter } from "./index.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

function startTestServer(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Lattice test page</h1></body></html>");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Bad address"));
      resolve({ url: `http://127.0.0.1:${addr.port}/`, server });
    });
    server.on("error", reject);
  });
}

describeIfBrowser("@lattice/engine — adapter integration (S1)", () => {
  let testUrl: string;
  let httpServer: Server;

  beforeAll(async () => {
    const { url, server } = await startTestServer();
    testUrl = url;
    httpServer = server;
  });

  afterAll(() => {
    httpServer?.close();
  });

  it("launches and shuts down cleanly", async () => {
    const adapter: EngineAdapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    await adapter.shutdown();
  });

  it("opens 3 contexts in parallel, navigates each, closes cleanly", async () => {
    const adapter: EngineAdapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    try {
      // Create 3 contexts concurrently
      const contexts = await Promise.all([
        adapter.createContext(),
        adapter.createContext(),
        adapter.createContext(),
      ]);

      // Navigate all 3 concurrently
      const results = await Promise.all(contexts.map((ctx) => ctx.navigate(testUrl)));

      for (const result of results) {
        expect(result.url).toContain("127.0.0.1");
        expect(result.statusCode).toBe(200);
      }

      // Verify stable IDs — all distinct
      const ids = contexts.map((c) => c.id);
      expect(new Set(ids).size).toBe(3);

      // currentUrl() reflects navigation
      for (const ctx of contexts) {
        expect(ctx.currentUrl()).toContain("127.0.0.1");
      }

      // Close all contexts cleanly
      await Promise.all(contexts.map((ctx) => ctx.close()));
    } finally {
      await adapter.shutdown();
    }
  });

  it("CDP session is ready after createContext()", async () => {
    const adapter: EngineAdapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    try {
      const ctx = await adapter.createContext();
      await ctx.navigate(testUrl);

      // Send a CDP command via the handle
      const cdp = ctx.cdp();
      const result = await cdp.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "document.title", returnByValue: true },
      );
      expect(result).toBeDefined();

      await ctx.close();
    } finally {
      await adapter.shutdown();
    }
  });
});
