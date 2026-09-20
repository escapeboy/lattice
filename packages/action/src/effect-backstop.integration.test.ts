/**
 * The effect backstop, against the case the static classifier cannot win.
 *
 * `<button type="button">Continue</button>` with a JS handler that POSTs. Every
 * DOM signal says benign — the type attribute says it is not a submit control,
 * the label is neutral, there is no form, no dialog, no amount. The classifier
 * auto-grants it, correctly, on the evidence it has. The POST is the evidence
 * that only exists after the click, and the backstop is what sees it.
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
<a id="plain" href="/static.txt">Read more</a>
<script>
  window.__posted = false;
  document.getElementById('quiet').addEventListener('click', async () => {
    try {
      await fetch('/api/orders', { method: 'POST', body: '{"qty":1}' });
      window.__posted = true;
    } catch (e) { window.__postError = String(e); }
  });
  document.getElementById('beacon').addEventListener('click', () => {
    navigator.sendBeacon('/collect', 'x');
  });
</script>
</body></html>`;

function startTestServer(): Promise<{ base: string; server: Server; posts: string[] }> {
  const posts: string[] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "POST") posts.push(req.url ?? "");
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("bad address"));
      resolve({ base: `http://127.0.0.1:${addr.port}`, server, posts });
    });
    server.on("error", reject);
  });
}

describeIfBrowser("effect backstop — gating on the request, not the prediction", () => {
  let base: string;
  let httpServer: Server;
  let posts: string[];
  let adapter: EngineAdapter;
  let ctx: ContextHandle;

  beforeAll(async () => {
    const s = await startTestServer();
    base = s.base;
    httpServer = s.server;
    posts = s.posts;
    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    ctx = await adapter.createContext();
  });

  afterAll(async () => {
    await ctx?.close();
    await adapter?.shutdown();
    httpServer?.close();
  });

  async function backendNodeIdFor(selector: string): Promise<number> {
    const cdp = ctx.cdp();
    const { root } = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    const { node } = await cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  }

  async function click(selector: string): Promise<void> {
    const backendNodeId = await backendNodeIdFor(selector);
    const p = await pointerPointFor(ctx.cdp(), backendNodeId, selector);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ctx.cdp().send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    }
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
    await ctx.navigate(`${base}/`);
    posts.length = 0;
    const escalated: PausedRequest[] = [];
    const backstop = new EffectBackstop(ctx.cdp(), {
      taskOrigin: base,
      onEscalate: (req) => {
        escalated.push(req);
        return Promise.resolve(false); // no human approved it
      },
    });
    await backstop.enable();
    try {
      backstop.arm();
      await click("#quiet");
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      backstop.disarm();
      await backstop.disable();
    }

    expect(escalated.map((e) => `${e.method} ${new URL(e.url).pathname}`)).toEqual(["POST /api/orders"]);
    // The request never reached the server.
    expect(posts).toEqual([]);
    const failed = await ctx.cdp().send<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression: "window.__posted === true",
      returnByValue: true,
    });
    expect(failed.result.value).toBe(false);
  });

  it("LETS THROUGH the same POST when a human approves it", async () => {
    await ctx.navigate(`${base}/`);
    posts.length = 0;
    const backstop = new EffectBackstop(ctx.cdp(), {
      taskOrigin: base,
      onEscalate: () => Promise.resolve(true),
    });
    await backstop.enable();
    try {
      backstop.arm();
      await click("#quiet");
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      backstop.disarm();
      await backstop.disable();
    }
    expect(posts).toEqual(["/api/orders"]);
  });

  it("does not hold an analytics beacon or a plain navigation", async () => {
    await ctx.navigate(`${base}/`);
    const escalated: PausedRequest[] = [];
    const backstop = new EffectBackstop(ctx.cdp(), {
      taskOrigin: base,
      onEscalate: (req) => {
        escalated.push(req);
        return Promise.resolve(true);
      },
    });
    await backstop.enable();
    try {
      backstop.arm();
      await click("#beacon");
      await click("#plain");
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      backstop.disarm();
      await backstop.disable();
    }
    // sendBeacon is a POST, but the browser labels it as a beacon resource — the
    // dominant false-positive source, and the one the browser identifies for us.
    expect(escalated.map((e) => `${e.resourceType} ${e.method}`)).toEqual([]);
  });

  it("does not hold requests outside the attribution window", async () => {
    await ctx.navigate(`${base}/`);
    posts.length = 0;
    const escalated: PausedRequest[] = [];
    const backstop = new EffectBackstop(ctx.cdp(), {
      taskOrigin: base,
      windowMs: 1,
      onEscalate: (req) => {
        escalated.push(req);
        return Promise.resolve(false);
      },
    });
    await backstop.enable();
    try {
      backstop.arm();
      await new Promise((r) => setTimeout(r, 60)); // window closes
      await click("#quiet");
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      await backstop.disable();
    }
    // The honest limit: a page that delays its POST past the window is missed.
    expect(escalated).toEqual([]);
    expect(posts).toEqual(["/api/orders"]);
  });

  it("measures the latency it costs", async () => {
    const time = async (withBackstop: boolean): Promise<number> => {
      await ctx.navigate(`${base}/`);
      const backstop = withBackstop
        ? new EffectBackstop(ctx.cdp(), { taskOrigin: base, onEscalate: () => Promise.resolve(true) })
        : undefined;
      await backstop?.enable();
      const started = performance.now();
      for (let i = 0; i < 10; i++) {
        await ctx.cdp().send("Runtime.evaluate", {
          expression: `fetch('/static.txt?i=${i}').then(r => r.text())`,
          awaitPromise: true,
          returnByValue: true,
        });
      }
      const elapsed = performance.now() - started;
      await backstop?.disable();
      return elapsed;
    };
    const off = await time(false);
    const on = await time(true);
    // Reported, not asserted as a threshold — the number belongs in the write-up.
    process.stderr.write(
      `\n[backstop] 10 same-origin fetches: ${off.toFixed(0)}ms off, ${on.toFixed(0)}ms on ` +
        `(+${(on - off).toFixed(0)}ms total, +${((on - off) / 10).toFixed(1)}ms/request)\n`,
    );
    expect(on).toBeGreaterThan(0);
  });
});
