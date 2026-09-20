/**
 * Regression tests for the lost-click bug.
 *
 * Every case here FAILED before `pointerPointFor`: the resolver handed back a
 * viewport-space coordinate taken without scrolling, so the dispatched mouse
 * event went to whatever happened to be at that point — usually nothing. The
 * click reported success and the page did not change.
 *
 * Each test asserts the observable page effect, never the return value, because
 * the old code returned success in exactly these situations.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { IGNode, InteractionGraph } from "@lattice/perception";
import { createActionEngine, ActionError, pointerPointFor, probeEffect } from "./index.js";
import { createSecurityKernel } from "@lattice/kernel";
import type { ActionEngine } from "./types.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const VIEWPORT = { width: 1280, height: 720 };

/** The measured failure: the target sat at document y=3858 in a 720px viewport. */
const PAGE_FAR_BELOW_FOLD = `<!DOCTYPE html><html lang="en"><head><title>Far below fold</title>
<style>body{margin:0}#spacer{height:3830px;background:#eee}#target{height:40px}</style></head>
<body>
<div id="spacer">filler</div>
<button id="target" onclick="document.title='CLICKED'">Deep target</button>
<div style="height:3000px"></div>
</body></html>`;

const PAGE_SCROLL_CONTAINER = `<!DOCTYPE html><html lang="en"><head><title>Scroll container</title>
<style>body{margin:0}#box{height:300px;overflow:auto;border:1px solid #000}
#inner{height:2400px}#target{margin-top:2000px}</style></head>
<body>
<div id="box"><div id="inner"><button id="target" onclick="document.title='CLICKED'">Boxed target</button></div></div>
</body></html>`;

/**
 * A sticky header tall enough that a MINIMAL scroll (which is what
 * DOM.scrollIntoViewIfNeeded performs) leaves the target underneath it. The
 * hit test must notice and the centring retry must recover it.
 */
const PAGE_STICKY_HEADER = `<!DOCTYPE html><html lang="en"><head><title>Sticky header</title>
<style>body{margin:0}
header{position:sticky;top:0;height:200px;background:#333;color:#fff;z-index:10}
#spacer{height:2000px}</style></head>
<body>
<header>sticky</header>
<div id="spacer">filler</div>
<button id="target" onclick="document.title='CLICKED'">Under the header</button>
<div style="height:2000px"></div>
</body></html>`;

/** Genuinely unreachable: a full-viewport overlay that no scroll can clear. */
const PAGE_BLOCKED = `<!DOCTYPE html><html lang="en"><head><title>Blocked</title>
<style>body{margin:0}
#veil{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99}
#spacer{height:2000px}</style></head>
<body>
<div id="veil"></div>
<div id="spacer">filler</div>
<button id="target" onclick="document.title='CLICKED'">Unreachable</button>
</body></html>`;

const IFRAME_INNER = `<!DOCTYPE html><html lang="en"><head><title>inner</title>
<style>body{margin:0}#spacer{height:1400px}</style></head>
<body>
<div id="spacer">inner filler</div>
<button id="target" onclick="parent.document.title='CLICKED'">Framed target</button>
</body></html>`;

const PAGE_IFRAME = `<!DOCTYPE html><html lang="en"><head><title>Iframe host</title>
<style>body{margin:0}#spacer{height:900px}iframe{width:900px;height:500px;border:0}</style></head>
<body>
<div id="spacer">host filler</div>
<iframe src="/inner" title="embedded"></iframe>
</body></html>`;

const PAGES: Record<string, string> = {
  "/far-below-fold": PAGE_FAR_BELOW_FOLD,
  "/scroll-container": PAGE_SCROLL_CONTAINER,
  "/sticky-header": PAGE_STICKY_HEADER,
  "/blocked": PAGE_BLOCKED,
  "/iframe": PAGE_IFRAME,
  "/inner": IFRAME_INNER,
};

function startTestServer(): Promise<{ base: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const html = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
      if (!html) {
        res.writeHead(404).end("no");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Bad address"));
      resolve({ base: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on("error", reject);
  });
}

describeIfBrowser("actuator — off-screen and obstructed targets (regression)", () => {
  let base: string;
  let httpServer: Server;
  let adapter: EngineAdapter;
  let ctx: ContextHandle;
  let actions: ActionEngine;

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const r = await ctx.cdp().send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return r.result.value;
  };

  /** Navigate, reset the viewport and scroll position, return the fresh L1 IG. */
  async function open(path: string): Promise<InteractionGraph> {
    await ctx.navigate(`${base}${path}`);
    await ctx.cdp().send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate("scrollTo(0,0); document.title = 'PENDING'; true");
    return (await createPerceptionEngine(ctx.cdp()).snapshot("L1")) as InteractionGraph;
  }

  function findButton(ig: InteractionGraph, label: string): IGNode {
    const node = Array.from(ig.nodes.values()).find(
      (n) => n.role === "button" && (n.label === label || n.axName === label),
    );
    expect(node, `button "${label}" missing from the IG`).toBeDefined();
    return node!;
  }

  beforeAll(async () => {
    const started = await startTestServer();
    base = started.base;
    httpServer = started.server;
    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    ctx = await adapter.createContext();
    const perception = createPerceptionEngine(ctx.cdp());
    actions = createActionEngine(ctx.cdp(), ctx, perception);
  });

  afterAll(async () => {
    await ctx?.close();
    await adapter?.shutdown();
    httpServer?.close();
  });

  it("clicks a target at y≈3858 in a 720px viewport", async () => {
    const ig = await open("/far-below-fold");
    const target = findButton(ig, "Deep target");

    // The precondition that used to break it: the box is far outside the
    // viewport, and the IG now says so.
    expect(target.geometry, "L1 must carry geometry").toBeDefined();
    expect(target.geometry!.y).toBeGreaterThan(3000);
    expect(target.geometry!.inViewport).toBe(false);

    await actions.execute({ type: "act", target: { nodeId: target.id } });

    expect(await evaluate<string>("document.title")).toBe("CLICKED");
  });

  it("clicks a target inside a scrollable container", async () => {
    const ig = await open("/scroll-container");
    const target = findButton(ig, "Boxed target");

    await actions.execute({ type: "act", target: { nodeId: target.id } });

    expect(await evaluate<string>("document.title")).toBe("CLICKED");
    // The container, not the page, is what had to move.
    expect(await evaluate<number>("document.getElementById('box').scrollTop")).toBeGreaterThan(0);
  });

  it("clicks a target that a sticky header would otherwise cover", async () => {
    const ig = await open("/sticky-header");
    const target = findButton(ig, "Under the header");

    await actions.execute({ type: "act", target: { nodeId: target.id } });

    expect(await evaluate<string>("document.title")).toBe("CLICKED");
    // Proof the click was not absorbed by the header: it is still on top at the
    // viewport's top edge, so a naive dispatch there would have hit it.
    expect(await evaluate<string>("document.elementFromPoint(640, 5).tagName")).toBe("HEADER");
  });

  /**
   * Iframes reach the pointer path only by backendNodeId today: perception's
   * `Accessibility.getFullAXTree` call is main-frame only, so it stops at the
   * `Iframe` node and the IG never enumerates what is inside (verified on this
   * fixture: 7 main-frame AX nodes, none named "Framed target"; the same call
   * with `frameId` returns 9 nodes and does contain it). That is a perception
   * gap, not an actuator one — so this test drives the actuator directly, which
   * is the unit under test, and the IG limitation is reported separately.
   */
  it("clicks a target inside a same-origin iframe", async () => {
    await open("/iframe");
    const cdp = ctx.cdp();

    const { frameTree } = await cdp.send<{
      frameTree: { childFrames?: Array<{ frame: { id: string } }> };
    }>("Page.getFrameTree", {});
    const frameId = frameTree.childFrames?.[0]?.frame.id;
    expect(frameId, "iframe did not attach").toBeDefined();

    const { nodes } = await cdp.send<{
      nodes: Array<{ name?: { value?: string }; backendDOMNodeId?: number }>;
    }>("Accessibility.getFullAXTree", { depth: -1, frameId });
    const framed = nodes.find((n) => n.name?.value === "Framed target");
    expect(framed?.backendDOMNodeId, "framed button missing from the frame AX tree").toBeDefined();

    // The geometry has to be converted across the frame boundary AND the frame
    // scrolled — getContentQuads answers in main-frame coordinates, but the
    // containment check has to run in the inner document.
    const point = await pointerPointFor(cdp, framed!.backendDOMNodeId!, "framed");
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);

    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type, x: point.x, y: point.y, button: "left", clickCount: 1,
      });
    }

    expect(await evaluate<string>("document.title")).toBe("CLICKED");
  });

  it("REFUSES a target under a full-viewport overlay instead of clicking through", async () => {
    const ig = await open("/blocked");
    const target = findButton(ig, "Unreachable");

    await expect(
      actions.execute({ type: "act", target: { nodeId: target.id } }),
    ).rejects.toThrow(ActionError);

    // And nothing was dispatched: the page is untouched.
    expect(await evaluate<string>("document.title")).toBe("PENDING");

    try {
      await actions.execute({ type: "act", target: { nodeId: target.id } });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as ActionError).code).toBe("obscured");
      // The message must name what blocked it — a bare failure is not actionable.
      expect((e as ActionError).message).toMatch(/covered by DIV/i);
    }
  });

  it("scroll_to actually scrolls (it used to be a no-op below the fold)", async () => {
    const ig = await open("/far-below-fold");
    const target = findButton(ig, "Deep target");

    expect(await evaluate<number>("scrollY")).toBe(0);
    await actions.execute({ type: "scroll_to", target: { nodeId: target.id } });
    expect(await evaluate<number>("scrollY")).toBeGreaterThan(3000);
  });
});

describeIfBrowser("iframe targets are consequential until perception covers frames", () => {
  let base: string;
  let httpServer: Server;
  let adapter: EngineAdapter;
  let ctx: ContextHandle;

  beforeAll(async () => {
    const started = await startTestServer();
    base = started.base;
    httpServer = started.server;
    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    ctx = await adapter.createContext();
  });

  afterAll(async () => {
    await ctx?.close();
    await adapter?.shutdown();
    httpServer?.close();
  });

  async function backendNodeIdIn(frameSelector: string | null, selector: string): Promise<number> {
    const cdp = ctx.cdp();
    if (frameSelector === null) {
      const { root } = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { node } = await cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
      return node.backendNodeId;
    }
    const { frameTree } = await cdp.send<{ frameTree: { childFrames?: Array<{ frame: { id: string } }> } }>(
      "Page.getFrameTree",
      {},
    );
    const frameId = frameTree.childFrames?.[0]?.frame.id;
    const { nodes } = await cdp.send<{ nodes: Array<{ name?: { value?: string }; backendDOMNodeId?: number }> }>(
      "Accessibility.getFullAXTree",
      { depth: -1, frameId },
    );
    const hit = nodes.find((n) => n.name?.value === selector);
    expect(hit?.backendDOMNodeId, `"${selector}" missing from the frame AX tree`).toBeDefined();
    return hit!.backendDOMNodeId!;
  }

  it("the probe reports inFrame for a control inside an iframe, and not for one outside", async () => {
    await ctx.navigate(`${base}/iframe`);
    await ctx.cdp().send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

    const framed = await probeEffect(ctx.cdp(), await backendNodeIdIn("iframe", "Framed target"));
    expect(framed.inFrame).toBe(true);
    expect(framed.frameOrigin).toBeDefined();

    const main = await probeEffect(ctx.cdp(), await backendNodeIdIn(null, "#spacer"));
    expect(main.inFrame).toBeUndefined();
  });

  it("the kernel gates a framed click that would otherwise be benign", async () => {
    await ctx.navigate(`${base}/iframe`);
    const kernel = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const framed = await probeEffect(ctx.cdp(), await backendNodeIdIn("iframe", "Framed target"));

    // Same control, same label — only the frame membership differs.
    const { inFrame, frameOrigin, ...unframed } = framed;
    void inFrame;
    void frameOrigin;
    const req = { actionType: "act", origin: base, sessionId: "t", payload: {} };
    expect(kernel.classify({ ...req, effect: unframed })).toBe("benign");
    expect(kernel.classify({ ...req, effect: framed })).toBe("consequential");
  });
});
