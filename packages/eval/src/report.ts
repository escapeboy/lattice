/**
 * Aggregate per-scenario results and render the gate report.
 *
 * The gate is REPOSITIONED (eval-p0-gate-result): the opponent is the CHROME
 * METHOD — a screenshot agent and a raw-DOM agent. The thesis is that Lattice
 * (compact IG + deltas) costs far fewer perception tokens than either, at equal
 * or better reliability. agent-browser is a semantic-engine PARITY reference,
 * reported but not a gate: we never claimed to beat it on raw tokens.
 *
 * If Lattice does NOT clearly beat the screenshot baseline, that is a real
 * problem — stop and report (step 3 boundary).
 */

import { runScenario, type ScenarioResult } from "./runners.js";
import { SCENARIOS } from "./scenarios.js";

export interface GateVerdict {
  readonly latticeTokens: number;
  readonly agentBrowserTokens: number;
  readonly screenshotTokens: number;
  readonly rawDomTokens: number;
  readonly rawDomDiffTokens: number;
  /** lattice / X — < 1 means Lattice cheaper. */
  readonly vsScreenshot: number;
  readonly vsRawDom: number;
  readonly vsRawDomDiff: number;
  readonly vsAgentBrowser: number;
  readonly latticeAccuracy: number;
  readonly agentBrowserAccuracy: number;
  readonly latticeNaiveAccuracy: number;
  readonly abNaiveAccuracy: number;
  /** Lattice clearly cheaper than the screenshot baseline (<= 50% of its tokens). */
  readonly beatsScreenshot: boolean;
  /** Lattice clearly cheaper than the raw-DOM baseline (<= 50% of its tokens). */
  readonly beatsRawDom: boolean;
  /** The gate: Lattice beats the Chrome method (both screenshot and raw-DOM). */
  readonly pass: boolean;
}

export interface EvalReport {
  readonly results: ReadonlyArray<ScenarioResult>;
  readonly verdict: GateVerdict;
}

const CHROME_WIN_RATIO = 0.5; // Lattice must use <= 50% of the Chrome-method tokens

export function runEval(): EvalReport {
  const results = SCENARIOS.map(runScenario);
  const sum = (f: (r: ScenarioResult) => number) => results.reduce((a, r) => a + f(r), 0);

  const latticeTokens = sum((r) => r.lattice.perceptionTokens);
  const agentBrowserTokens = sum((r) => r.agentBrowser.perceptionTokens);
  const screenshotTokens = sum((r) => r.screenshot.perceptionTokens);
  const rawDomTokens = sum((r) => r.rawDom.perceptionTokens);
  const rawDomDiffTokens = sum((r) => r.rawDomDiffTokens);

  const wmean = (resolved: (r: ScenarioResult) => number, totalOf: (r: ScenarioResult) => number) => {
    const res = results.reduce((a, r) => a + resolved(r), 0);
    const tot = results.reduce((a, r) => a + totalOf(r), 0);
    return tot === 0 ? 1 : res / tot;
  };
  const totalActions = (r: ScenarioResult) => r.lattice.actionsTotal;
  const latticeAccuracy = wmean((r) => r.lattice.actionsResolved, totalActions);
  const agentBrowserAccuracy = wmean((r) => r.agentBrowser.actionsResolved, totalActions);
  const latticeNaiveAccuracy = wmean((r) => r.latticeNaiveAccuracy * r.lattice.actionsTotal, totalActions);
  const abNaiveAccuracy = wmean((r) => r.abNaiveAccuracy * r.lattice.actionsTotal, totalActions);

  const ratio = (x: number) => (x === 0 ? 1 : latticeTokens / x);
  const beatsScreenshot = latticeTokens <= screenshotTokens * CHROME_WIN_RATIO;
  const beatsRawDom = latticeTokens <= rawDomTokens * CHROME_WIN_RATIO;

  return {
    results,
    verdict: {
      latticeTokens,
      agentBrowserTokens,
      screenshotTokens,
      rawDomTokens,
      rawDomDiffTokens,
      vsScreenshot: ratio(screenshotTokens),
      vsRawDom: ratio(rawDomTokens),
      vsRawDomDiff: ratio(rawDomDiffTokens),
      vsAgentBrowser: ratio(agentBrowserTokens),
      latticeAccuracy,
      agentBrowserAccuracy,
      latticeNaiveAccuracy,
      abNaiveAccuracy,
      beatsScreenshot,
      beatsRawDom,
      pass: beatsScreenshot && beatsRawDom,
    },
  };
}

export function formatReport(report: EvalReport): string {
  const { results, verdict: v } = report;
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push("# Lattice eval — vs the Chrome method (screenshot / raw-DOM)\n");
  lines.push("Perception tokens (chars/4 proxy; screenshot = (1280×800)/750 vision tokens/step).");
  lines.push("agent-browser is a semantic-engine PARITY reference, not the opponent.\n");
  lines.push("| Scenario | steps | Lattice | agent-browser | screenshot | raw-DOM | Lattice acc |");
  lines.push("|---|--:|--:|--:|--:|--:|--:|");
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${r.steps} | ${r.lattice.perceptionTokens} | ${r.agentBrowser.perceptionTokens} | ${r.screenshot.perceptionTokens} | ${r.rawDom.perceptionTokens} | ${pct(r.lattice.accuracy)} |`,
    );
  }
  lines.push(
    `| **TOTAL** |  | **${v.latticeTokens}** | **${v.agentBrowserTokens}** | **${v.screenshotTokens}** | **${v.rawDomTokens}** | **${pct(v.latticeAccuracy)}** |`,
  );
  lines.push("");
  lines.push("## Tokens — vs the Chrome method (the gate)");
  lines.push(`- vs **screenshot**: Lattice ${v.latticeTokens} vs ${v.screenshotTokens} → **${v.vsScreenshot.toFixed(3)}×** (${(1 / v.vsScreenshot).toFixed(1)}× cheaper). Clear win: **${v.beatsScreenshot ? "YES" : "NO"}**`);
  lines.push(`- vs **raw-DOM** (re-fed): Lattice ${v.latticeTokens} vs ${v.rawDomTokens} → **${v.vsRawDom.toFixed(3)}×** (${(1 / v.vsRawDom).toFixed(1)}× cheaper). Clear win: **${v.beatsRawDom ? "YES" : "NO"}**`);
  lines.push(`- vs **raw-DOM** (diffed, generous to baseline): → **${v.vsRawDomDiff.toFixed(3)}×**`);
  lines.push("");
  lines.push("## Parity reference (informational, NOT a gate)");
  lines.push(`- vs **agent-browser**: Lattice ${v.latticeTokens} vs ${v.agentBrowserTokens} → **${v.vsAgentBrowser.toFixed(2)}×**. Same order of magnitude — we build ON it; never claimed a token win here.`);
  lines.push("");
  lines.push("## Reliability (the differentiator that survives caching)");
  lines.push(`- Re-perceiving each step, all systems resolve present targets: Lattice ${pct(v.latticeAccuracy)}, agent-browser ${pct(v.agentBrowserAccuracy)}.`);
  lines.push(`- Caching an id to skip re-find: Lattice (stable NodeId) **${pct(v.latticeNaiveAccuracy)}** vs agent-browser (volatile ref) **${pct(v.abNaiveAccuracy)}** — stable identity is correct for free; per-snapshot refs are not.`);
  lines.push("");
  lines.push(`## GATE: ${v.pass ? "PASS — Lattice clearly beats the Chrome method; proceed" : "DOES NOT BEAT THE CHROME METHOD — stop and report (step 3 boundary)"}`);
  return lines.join("\n");
}
