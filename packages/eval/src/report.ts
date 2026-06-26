/**
 * Aggregate the per-scenario results and render the gate report. The gate
 * (improvements-backlog P0): Lattice must be SIGNIFICANTLY better than bare
 * agent-browser on tokens OR success rate, or we stop and report.
 */

import { runScenario, type ScenarioResult } from "./runners.js";
import { SCENARIOS } from "./scenarios.js";

export interface GateVerdict {
  readonly latticeTokens: number;
  readonly abFullTokens: number;
  readonly abDiffTokens: number;
  readonly abBestTokens: number; // the baseline's best (cheapest) mode
  readonly tokenRatio: number; // lattice / abBest  (<1 means Lattice cheaper)
  readonly latticeAccuracy: number;
  readonly abFairAccuracy: number;
  readonly abNaiveAccuracy: number;
  /** Lattice is significantly cheaper on tokens (>= 20% fewer than baseline best). */
  readonly tokensWin: boolean;
  /** Lattice resolves significantly more actions than the FAIR baseline (>= +5pp). */
  readonly successWin: boolean;
  readonly pass: boolean;
}

export interface EvalReport {
  readonly results: ReadonlyArray<ScenarioResult>;
  readonly verdict: GateVerdict;
}

const TOKEN_WIN_RATIO = 0.8; // Lattice must use <= 80% of baseline tokens to "win"
const SUCCESS_WIN_MARGIN = 0.05; // +5 percentage points to "win" on success

export function runEval(): EvalReport {
  const results = SCENARIOS.map(runScenario);
  const sum = (f: (r: ScenarioResult) => number) => results.reduce((a, r) => a + f(r), 0);

  const latticeTokens = sum((r) => r.lattice.perceptionTokens);
  const abFullTokens = sum((r) => r.abFull.perceptionTokens);
  const abDiffTokens = sum((r) => r.abDiff.perceptionTokens);
  const abBestTokens = Math.min(abFullTokens, abDiffTokens);

  const wmean = (f: (r: ScenarioResult) => { actionsResolved: number; actionsTotal: number }) => {
    const res = results.reduce((a, r) => a + f(r).actionsResolved, 0);
    const tot = results.reduce((a, r) => a + f(r).actionsTotal, 0);
    return tot === 0 ? 1 : res / tot;
  };
  const latticeAccuracy = wmean((r) => r.lattice);
  const abFairAccuracy = wmean((r) => r.abFull); // fair re-find accuracy
  const abNaiveAccuracy =
    results.reduce((a, r) => a + r.abNaiveAccuracy * r.lattice.actionsTotal, 0) /
    Math.max(1, results.reduce((a, r) => a + r.lattice.actionsTotal, 0));

  const tokensWin = latticeTokens <= abBestTokens * TOKEN_WIN_RATIO;
  const successWin = latticeAccuracy >= abFairAccuracy + SUCCESS_WIN_MARGIN;

  return {
    results,
    verdict: {
      latticeTokens,
      abFullTokens,
      abDiffTokens,
      abBestTokens,
      tokenRatio: abBestTokens === 0 ? 1 : latticeTokens / abBestTokens,
      latticeAccuracy,
      abFairAccuracy,
      abNaiveAccuracy,
      tokensWin,
      successWin,
      pass: tokensWin || successWin,
    },
  };
}

export function formatReport(report: EvalReport): string {
  const { results, verdict: v } = report;
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push("# Lattice eval — build-on vs bare agent-browser (P0 gate)\n");
  lines.push("Perception tokens (chars/4 proxy, identical for both) + action accuracy.\n");
  lines.push("| Scenario | perceives | Lattice tok | ab-full tok | ab-diff tok | Lattice acc | ab(fair) acc | ab(naive) acc |");
  lines.push("|---|--:|--:|--:|--:|--:|--:|--:|");
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${r.lattice.perceiveCount} | ${r.lattice.perceptionTokens} | ${r.abFull.perceptionTokens} | ${r.abDiff.perceptionTokens} | ${pct(r.lattice.accuracy)} | ${pct(r.abFull.accuracy)} | ${pct(r.abNaiveAccuracy)} |`,
    );
  }
  lines.push(
    `| **TOTAL** |  | **${v.latticeTokens}** | **${v.abFullTokens}** | **${v.abDiffTokens}** | **${pct(v.latticeAccuracy)}** | **${pct(v.abFairAccuracy)}** | **${pct(v.abNaiveAccuracy)}** |`,
  );
  lines.push("");
  lines.push(`- Tokens: Lattice **${v.latticeTokens}** vs baseline best **${v.abBestTokens}** → ratio **${v.tokenRatio.toFixed(2)}×** (Lattice cheaper only if < 1).`);
  lines.push(`- Tokens win (Lattice <= 80% of baseline): **${v.tokensWin ? "YES" : "NO"}**`);
  lines.push(`- Success win (Lattice acc >= fair baseline +5pp): **${v.successWin ? "YES" : "NO"}**`);
  lines.push(`  - vs NAIVE ref-caching baseline, Lattice acc ${pct(v.latticeAccuracy)} vs ${pct(v.abNaiveAccuracy)} — the failure mode stable identity prevents.`);
  lines.push("");
  lines.push(`## GATE: ${v.pass ? "PASS — proceed to P1" : "DOES NOT PASS — stop and report (valid result, not a failure)"}`);
  return lines.join("\n");
}
