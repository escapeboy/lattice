/**
 * Responsive breakpoint sanity check.
 *
 * Answers "does the navigation collapse at 390px?" purely through perception —
 * no manual DevTools. L1 (Interaction Graph) decides presence; L3 (geometry)
 * is fetched only when a toggle is present, to confirm it actually renders.
 */

import type { EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { IGNode, InteractionGraph } from "@lattice/perception";
import { TraceRecorder } from "@lattice/observability";
import type { SessionTrace } from "@lattice/observability";
import { applyProfile, DESKTOP_PROFILE, MOBILE_PROFILE } from "./profiles.js";
import type { BreakpointReport, DeviceProfile, ViewportFinding } from "./types.js";

const QUERY = "Does the navigation collapse to a menu toggle at 390px width?";

function isInteractionGraph(snap: { tier: string }): snap is InteractionGraph {
  return snap.tier !== "L0";
}

function navLinks(ig: InteractionGraph): IGNode[] {
  // Count link-role nodes. We deliberately do NOT key on href: the S2 AX layer
  // does not reliably populate href (see feedback-href-not-populated), and the
  // collapse signal is link *presence*, which the accessibility tree captures
  // directly (display:none links leave the tree entirely).
  return Array.from(ig.nodes.values()).filter((n) => n.role === "link");
}

function findHamburger(ig: InteractionGraph): IGNode | undefined {
  return Array.from(ig.nodes.values()).find(
    (n) => n.role === "button" && /menu/i.test(n.label),
  );
}

async function probeViewport(
  adapter: EngineAdapter,
  url: string,
  profile: DeviceProfile,
  recorder: TraceRecorder,
): Promise<ViewportFinding> {
  const ctx = await adapter.createContext();
  try {
    await applyProfile(ctx.cdp(), profile);
    await ctx.navigate(url);

    const engine = createPerceptionEngine(ctx.cdp());
    const l1 = await engine.snapshot("L1");
    if (!isInteractionGraph(l1)) throw new Error("L1 snapshot did not return an Interaction Graph");
    recorder.recordSnapshot("L1", l1.url, l1.title, Array.from(l1.nodes.values()));

    const links = navLinks(l1);
    const hamburger = findHamburger(l1);

    // L3 escalation only when a toggle is present — confirm it truly renders.
    let hamburgerGeometry: ViewportFinding["hamburgerGeometry"];
    let hamburgerVisible = false;
    if (hamburger) {
      const l3 = await engine.snapshot("L3");
      if (isInteractionGraph(l3)) {
        recorder.recordSnapshot("L3", l3.url, l3.title, Array.from(l3.nodes.values()));
        const geo = l3.nodes.get(hamburger.id)?.geometry;
        if (geo) {
          hamburgerGeometry = geo;
          hamburgerVisible =
            geo.width > 0 && geo.height > 0 && geo.x >= 0 && geo.x < profile.width;
        }
      }
    }

    const collapsed = links.length === 0 && hamburger !== undefined && hamburgerVisible;

    return {
      profile: profile.label,
      viewport: { width: profile.width, height: profile.height, dpr: profile.deviceScaleFactor },
      navLinkCount: links.length,
      hamburgerPresent: hamburger !== undefined,
      ...(hamburgerGeometry !== undefined ? { hamburgerGeometry } : {}),
      hamburgerVisible,
      collapsed,
    };
  } finally {
    await ctx.close();
  }
}

export interface ResponsiveCheckResult {
  readonly report: BreakpointReport;
  readonly trace: SessionTrace;
}

/**
 * Run the mobile + desktop probes against `url` and produce a breakpoint report
 * plus a deterministic trace. `adapter` must already be launched.
 */
export async function runResponsiveCheck(
  adapter: EngineAdapter,
  url: string,
  sessionId = "demo-responsive",
): Promise<ResponsiveCheckResult> {
  const recorder = new TraceRecorder(sessionId);
  recorder.recordAction({ type: "extract", query: QUERY });

  const mobile = await probeViewport(adapter, url, MOBILE_PROFILE, recorder);
  const desktop = await probeViewport(adapter, url, DESKTOP_PROFILE, recorder);

  const navCollapsesAt390 = mobile.collapsed && !desktop.collapsed;
  const answer = navCollapsesAt390
    ? `Yes. At 390px the ${desktop.navLinkCount} inline nav links are replaced by a single menu toggle; at ${desktop.viewport.width}px the links render inline and no toggle is shown.`
    : mobile.collapsed
      ? "Inconclusive: the nav is collapsed at 390px but also collapsed on desktop — not a width-driven breakpoint."
      : "No. The navigation does not collapse to a menu toggle at 390px.";

  const report: BreakpointReport = { url, query: QUERY, mobile, desktop, navCollapsesAt390, answer };

  recorder.recordActionResult(true, url, report);
  const trace = recorder.finish();

  return { report, trace };
}
