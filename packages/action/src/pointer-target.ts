/**
 * Pointer targeting — scroll, re-resolve, hit-test, and only then dispatch.
 *
 * THE BUG THIS EXISTS TO CLOSE
 * `DOM.getBoxModel` / `DOM.getContentQuads` return CSS pixels relative to the
 * *viewport*. Nothing scrolled the target into view first, so an element below
 * the fold resolved to a point outside the viewport and
 * `Input.dispatchMouseEvent` delivered the click to nothing at all. The action
 * reported success and the page did not change. Measured on
 * en.wikipedia.org/wiki/Interaction_design (viewport 1280x720, page 7358 tall):
 * the `usability` link resolved to y=3858 and ten consecutive clicks were lost.
 * A skip-link resolved to (0,0) and would have clicked whatever sat in the
 * corner.
 *
 * THE RULE
 * Never dispatch a pointer event at a point we have not just verified hit-tests
 * to the intended node (or a descendant of it). If it cannot be verified, throw
 * — a lost click is worse than a refused one, because the caller believes it
 * happened.
 */

import type { CDPHandle } from "@lattice/engine";
import { ActionError } from "./types.js";

interface Quad {
  readonly x: number;
  readonly y: number;
}

interface GetContentQuadsResult {
  quads?: number[][];
}

interface GetNodeForLocationResult {
  backendNodeId?: number;
  nodeId?: number;
}

interface ResolveNodeResult {
  object?: { objectId?: string };
}

interface CallFunctionOnResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

interface LayoutMetricsResult {
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
  cssVisualViewport?: { clientWidth: number; clientHeight: number };
}

export interface PointerPoint {
  /** Main-frame viewport CSS pixels — what Input.dispatchMouseEvent expects. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How the point was confirmed to land on the target. */
  readonly verifiedBy: "getNodeForLocation" | "elementFromPoint";
  /** True when a second, centring scroll was needed. */
  readonly recentred: boolean;
}

/** Centre of the first content quad, in main-frame viewport coordinates. */
function quadCentre(quad: number[]): Quad & { width: number; height: number } {
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

async function layoutViewport(cdp: CDPHandle): Promise<{ width: number; height: number }> {
  try {
    const m = await cdp.send<LayoutMetricsResult>("Page.getLayoutMetrics", {});
    const vp = m.cssLayoutViewport ?? m.cssVisualViewport;
    if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
      return { width: vp.clientWidth, height: vp.clientHeight };
    }
  } catch {
    // fall through
  }
  return { width: 0, height: 0 };
}

/**
 * Hit-test in the target's OWN document.
 *
 * `DOM.getNodeForLocation` answers in main-frame coordinates, which is what we
 * dispatch in; but for a node inside an iframe the containment check has to run
 * in that node's document. `getBoundingClientRect` is already relative to the
 * node's own document viewport, so asking the element itself avoids any
 * cross-frame coordinate conversion.
 */
const HIT_IN_OWN_DOCUMENT = `function () {
  const r = this.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok: false, reason: "zero-size" };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const doc = this.ownerDocument;
  const view = doc.defaultView;
  if (cx < 0 || cy < 0 || cx > view.innerWidth || cy > view.innerHeight) {
    return { ok: false, reason: "outside-own-viewport" };
  }
  const el = doc.elementFromPoint(cx, cy);
  if (!el) return { ok: false, reason: "no-element-at-point" };
  const hit = el === this || this.contains(el);
  return {
    ok: hit,
    reason: hit ? "hit" : "covered",
    coveredBy: hit ? null : (el.tagName || "") + (el.className ? "." + String(el.className).slice(0, 40) : ""),
  };
}`;

const SCROLL_TO_CENTRE = `function () {
  this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return true;
}`;

async function resolveObjectId(cdp: CDPHandle, backendNodeId: number): Promise<string | undefined> {
  try {
    const r = await cdp.send<ResolveNodeResult>("DOM.resolveNode", { backendNodeId });
    return r.object?.objectId;
  } catch {
    return undefined;
  }
}

async function callOn<T>(cdp: CDPHandle, objectId: string, fn: string): Promise<T | undefined> {
  try {
    const r = await cdp.send<CallFunctionOnResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      returnByValue: true,
    });
    if (r.exceptionDetails) return undefined;
    return r.result?.value as T;
  } catch {
    return undefined;
  }
}

async function contentQuadCentre(
  cdp: CDPHandle,
  backendNodeId: number,
): Promise<(Quad & { width: number; height: number }) | undefined> {
  try {
    const { quads } = await cdp.send<GetContentQuadsResult>("DOM.getContentQuads", { backendNodeId });
    const first = quads?.find((q) => q.length >= 8);
    return first ? quadCentre(first) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring `backendNodeId` into view and return a point that provably hits it.
 *
 * Throws `obscured` rather than returning an unverified point — the whole
 * failure mode being fixed is a click that silently lands nowhere.
 */
export async function pointerPointFor(
  cdp: CDPHandle,
  backendNodeId: number,
  nodeIdForMessages: string,
): Promise<PointerPoint> {
  // DOM.getDocument primes the DOM agent; without it getNodeForLocation can
  // answer for a stale document on some Chrome builds.
  await cdp.send("DOM.getDocument", { depth: 0 }).catch(() => undefined);

  const objectId = await resolveObjectId(cdp, backendNodeId);
  let recentred = false;
  let lastReason = "unknown";
  let coveredBy: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 0) {
      await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(async () => {
        // Older targets / detached agents: fall back to the DOM API.
        if (objectId) await callOn(cdp, objectId, SCROLL_TO_CENTRE);
      });
    } else {
      // Minimal scrolling can leave the target under a sticky header; centring
      // it is the cheap second try before giving up.
      if (!objectId) break;
      await callOn(cdp, objectId, SCROLL_TO_CENTRE);
      recentred = true;
    }

    const centre = await contentQuadCentre(cdp, backendNodeId);
    if (!centre || centre.width === 0 || centre.height === 0) {
      lastReason = "no-layout-box";
      continue;
    }

    const vp = await layoutViewport(cdp);
    const insideViewport =
      vp.width === 0 ||
      (centre.x >= 0 && centre.y >= 0 && centre.x <= vp.width && centre.y <= vp.height);
    if (!insideViewport) {
      lastReason = `outside-viewport(${Math.round(centre.x)},${Math.round(centre.y)} vs ${vp.width}x${vp.height})`;
      continue;
    }

    // Primary check: main-frame hit test at the exact dispatch point.
    const hit = await cdp
      .send<GetNodeForLocationResult>("DOM.getNodeForLocation", {
        x: Math.round(centre.x),
        y: Math.round(centre.y),
        includeUserAgentShadowDOM: false,
      })
      .catch(() => undefined);

    if (hit?.backendNodeId === backendNodeId) {
      return { x: centre.x, y: centre.y, width: centre.width, height: centre.height, verifiedBy: "getNodeForLocation", recentred };
    }

    // The hit node is usually a descendant (the <span> inside a <button>), and
    // for an iframe it lives in another document. Ask the element itself.
    if (objectId) {
      const own = await callOn<{ ok: boolean; reason: string; coveredBy: string | null }>(
        cdp,
        objectId,
        HIT_IN_OWN_DOCUMENT,
      );
      if (own?.ok) {
        return { x: centre.x, y: centre.y, width: centre.width, height: centre.height, verifiedBy: "elementFromPoint", recentred };
      }
      lastReason = own?.reason ?? "hit-test-failed";
      coveredBy = own?.coveredBy ?? null;
    } else {
      lastReason = "hit-test-failed";
    }
  }

  throw new ActionError(
    "obscured",
    "scroll the target into view or dismiss the overlay, then re-perceive",
    `Refusing to click node ${nodeIdForMessages}: ${lastReason}` +
      (coveredBy ? ` (covered by ${coveredBy})` : ""),
  );
}
