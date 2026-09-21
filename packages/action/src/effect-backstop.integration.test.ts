/**
 * The effect backstop against a real browser.
 *
 * The case it exists for: `<button type="button">Continue</button>` whose
 * handler POSTs. Every DOM signal says benign and the classifier is right on
 * the evidence it has — the POST is evidence that only exists after the click.
 *
 * The cases it must NOT fire on are the reason it can be left on: beacons,
 * telemetry hosts, GraphQL reads, a background autosave that was already
 * running, and anything a different frame did.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createSecurityKernel } from "@lattice/kernel";
import { EffectBackstop, type PausedRequest } from "./effect-backstop.js";
import { probeEffect } from "./effect-probe.js";
import { pointerPointFor } from "./pointer-target.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Quiet POST</title></head>
<body>
<p>Nothing here commits anything.</p>
<button id="quiet" type="button">Continue</button>
<button id="beacon" type="button">Track</button>
<button id="telemetry" type="button">Report</button>
<button id="gqlread" type="button">Load cart</button>
<button id="gqlwrite" type="button">Place order</button>
<button id="persisted" type="button">Persisted</button>
<a id="plain" href="/static.txt">Read more</a>
<script>
  window.__posted = false;
  const post = (url, body, init) => fetch(url, { method: 'POST', body, ...(init || {}) });
  document.getElementById('quiet').addEventListener('click', async () => {
    try { await post('/api/orders', '{"qty":1}'); window.__posted = true; }
    catch (e) { window.__postError = String(e); }
  });
  document.getElementById('beacon').addEventListener('click', () => {
    navigator.sendBeacon('/collect', 'x');
  });
  document.getElementById('telemetry').addEventListener('click', () => {
    // Same shape as an analytics SDK: a real POST to a known telemetry host.
    post('TELEMETRY_URL', '{"e":"click"}').catch(() => {});
  });
  document.getElementById('gqlread').addEventListener('click', () => {
    post('/graphql', JSON.stringify({ query: 'query Cart { cart { id } }' }),
         { headers: { 'content-type': 'application/json' } }).catch(() => {});
  });
  document.getElementById('gqlwrite').addEventListener('click', () => {
    post('/graphql', JSON.stringify({ query: 'mutation PlaceOrder { placeOrder { id } }' }),
         { headers: { 'content-type': 'application/json' } }).catch(() => {});
  });
  document.getElementById('persisted').addEventListener('click', () => {
    post('/graphql', JSON.stringify({ extensions: { persistedQuery: { version: 1, sha256Hash: 'deadbeef' } } }),
         { headers: { 'content-type': 'application/json' } }).catch(() => {});
  });
  // Background autosave: starts immediately, before the agent does anything.
  setInterval(() => { post('/api/draft', '{"t":1}').catch(() => {}); }, 120);
  post('/api/draft', '{"t":0}').catch(() => {});
</script>
</body></html>`;

function startTestServer(): Promise<{ base: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") hits.push(req.url ?? "");
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE.replace("TELEMETRY_URL", `http://www.google-analytics.com:${PORT.value}/g/collect`));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }).end("{}");
  });
  const PORT = { value: 0 };
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("bad address"));
      PORT.value = addr.port;
      resolve({ base: `http://127.0.0.1:${addr.port}`, server, hits });
    });
    server.on("error", reject);
  });
}

describeIfBrowser("effect backstop — gating on the request, not the prediction", () => {
  let base: string;
  let httpServer: Server;
  let hits: string[];
  let adapter: EngineAdapter;
  let ctx: ContextHandle;

  beforeAll(async () => {
    const s = await startTestServer();
    base = s.base;
    httpServer = s.server;
    hits = s.hits;
    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    ctx = await adapter.createContext();
  });

  afterAll(async () => {
    await ctx?.close();
    await adapter?.shutdown();
    httpServer?.close();
  });

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const r = await ctx.cdp().send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true });
    return r.result.value;
  };

  async function backendNodeIdFor(selector: string): Promise<number> {
    const cdp = ctx.cdp();
    const { root } = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { node } = await cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  }

  async function click(selector: string): Promise<void> {
    const p = await pointerPointFor(ctx.cdp(), await backendNodeIdFor(selector), selector);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ctx.cdp().send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    }
  }

  /**
   * One armed action. `settleMs` lets the page's background autosave tick a few
   * times before arming, so the baseline is real rather than assumed.
   */
  async function armedClick(
    selector: string,
    opts: { approve?: boolean; settleMs?: number } = {},
  ): Promise<{ escalated: PausedRequest[]; backstop: EffectBackstop }> {
    await ctx.navigate(`${base}/`);
    hits.length = 0;
    const escalated: PausedRequest[] = [];
    const backstop = new EffectBackstop(ctx.cdp(), {
      taskOrigin: base,
      telemetryHosts: ["google-analytics.com"],
      onEscalate: (req) => {
        escalated.push(req);
        return Promise.resolve(opts.approve === true);
      },
    });
    await backstop.observe();
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 400));
    await backstop.arm();
    await click(selector);
    await new Promise((r) => setTimeout(r, 700));
    await backstop.disarm();
    await backstop.dispose();
    return { escalated, backstop };
  }

  it("the static classifier auto-grants the lying button — correctly, on its evidence", async () => {
    await ctx.navigate(`${base}/`);
    const evidence = await probeEffect(ctx.cdp(), await backendNodeIdFor("#quiet"));
    expect(evidence.probeFailed).toBeUndefined();
    expect(evidence.inputType).toBe("button");
    expect(evidence.submitControl).toBeUndefined();

    const kernel = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    expect(kernel.classify({ actionType: "act", origin: base, sessionId: "t", payload: {}, effect: evidence })).toBe(
      "benign",
    );
  });

  it("BLOCKS the POST that a benign-looking click produced", async () => {
    const { escalated } = await armedClick("#quiet");
    expect(escalated.map((e) => `${e.method} ${new URL(e.url).pathname}`)).toEqual(["POST /api/orders"]);
    expect(hits.filter((h) => h === "/api/orders")).toEqual([]);
    expect(await evaluate<boolean>("window.__posted === true")).toBe(false);
  });

  it("LETS THROUGH the same POST when a human approves it", async () => {
    const { escalated } = await armedClick("#quiet", { approve: true });
    expect(escalated).toHaveLength(1);
    expect(hits.filter((h) => h === "/api/orders")).toEqual(["/api/orders"]);
  });

  it("does not hold a sendBeacon", async () => {
    const { escalated } = await armedClick("#beacon");
    expect(escalated).toEqual([]);
  });

  it("does not hold a POST to a telemetry host", async () => {
    const { escalated } = await armedClick("#telemetry");
    expect(escalated.map((e) => e.url)).toEqual([]);
  });

  it("does not hold a GraphQL QUERY, but holds a MUTATION on the same endpoint", async () => {
    const read = await armedClick("#gqlread");
    expect(read.escalated, "a query must pass").toEqual([]);

    const write = await armedClick("#gqlwrite");
    expect(write.escalated).toHaveLength(1);
    expect(write.escalated[0]!.reason).toContain("mutation");
    expect(hits.filter((h) => h === "/graphql")).toEqual([]);
  });

  it("holds a persisted GraphQL query — the hash hides the effect", async () => {
    const { escalated } = await armedClick("#persisted");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.reason).toContain("persisted");
  });

  it("does not hold the background autosave that was already running", async () => {
    // The page PUTs /api/draft on a timer from load. It fires during the armed
    // window too — and must pass, because the click did not cause it.
    const { escalated, backstop } = await armedClick("#beacon", { settleMs: 600 });
    expect(escalated).toEqual([]);
    expect(backstop.stats().baseline).toBeGreaterThan(0);
    // It really did keep firing while armed, so this is not a vacuous check.
    expect(hits.filter((h) => h === "/api/draft").length).toBeGreaterThan(0);
  });

  it("is inert when disarmed — nothing is paused outside the window", async () => {
    await ctx.navigate(`${base}/`);
    const escalated: PausedRequest[] = [];
    const backstop = new EffectBackstop(ctx.cdp(), {
      taskOrigin: base,
      onEscalate: (r) => {
        escalated.push(r);
        return Promise.resolve(false);
      },
    });
    await backstop.observe();
    await click("#quiet"); // never armed
    await new Promise((r) => setTimeout(r, 500));
    await backstop.dispose();
    expect(escalated).toEqual([]);
    expect(backstop.stats().seen).toBe(0);
  });

  it("measures the latency it costs", async () => {
    const time = async (armed: boolean): Promise<number> => {
      await ctx.navigate(`${base}/`);
      const backstop = new EffectBackstop(ctx.cdp(), { taskOrigin: base, onEscalate: () => Promise.resolve(true) });
      await backstop.observe();
      if (armed) await backstop.arm();
      const started = performance.now();
      for (let i = 0; i < 10; i++) {
        await ctx.cdp().send("Runtime.evaluate", {
          expression: `fetch('/static.txt?i=${i}').then(r => r.text())`,
          awaitPromise: true,
          returnByValue: true,
        });
      }
      const elapsed = performance.now() - started;
      await backstop.dispose();
      return elapsed;
    };
    const off = await time(false);
    const on = await time(true);
    process.stderr.write(
      `\n[backstop] 10 same-origin GETs: ${off.toFixed(0)}ms disarmed, ${on.toFixed(0)}ms armed ` +
        `(+${((on - off) / 10).toFixed(2)}ms/request while armed; 0 while disarmed)\n`,
    );
    expect(on).toBeGreaterThan(0);
  });
});
