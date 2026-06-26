/**
 * Perception-cache eval (P2.2) — measures the per-origin cache's effect on
 * perception tokens across a REPEATED flow, reporting COLD and WARM separately.
 *
 * The agent runs the same 17-step task-tracker flow twice on the same origin
 * (a realistic "do the task again" / fan-out-revisit pattern). We compare:
 *
 *   - no cache  : every pass re-sends the full IG step 0 + deltas (2× cold).
 *   - cache     : pass 1 is COLD (full skeleton paid); pass 2 is WARM (only nodes
 *                 that differ from what the origin already sent — ≈0 for an
 *                 unchanged revisit).
 *
 * HONEST: the cache does NOT reduce the cold cost — the stable-NodeId base cost
 * (≈ the 950/flow figure) is still paid the first time. It AMORTIZES that cost on
 * repeat visits. Cold and warm are reported as separate numbers so amortization
 * is never presented as fixing the base cost.
 */

import { snapshotToIG, compactNodes, compactDelta, igDelta, PerceptionCache } from "@lattice/perception";
import { estimateTokens } from "./tokens.js";
import { taskTrackerFlow, synthFrame } from "./synth.js";

const ORIGIN = "https://tracker.example.com";

function flowIGs() {
  return taskTrackerFlow().map((s) => snapshotToIG(synthFrame(s.state).raw, { tier: "L1" }).graph);
}

/** Lattice cost for one pass WITHOUT the cache: full compact IG, then deltas. */
function passTokensNoCache(graphs: ReturnType<typeof flowIGs>): number {
  let tokens = 0;
  for (let i = 0; i < graphs.length; i++) {
    tokens +=
      i === 0
        ? estimateTokens(JSON.stringify(compactNodes(graphs[i]!.nodes.values())))
        : estimateTokens(JSON.stringify(compactDelta(igDelta(graphs[i - 1]!, graphs[i]!))));
  }
  return tokens;
}

/**
 * Lattice cost for one pass WITH the cache: each step sends only the nodes that
 * differ from what this origin already delivered. A cold origin pays the full
 * skeleton; a warm one pays only the genuine change.
 */
function passTokensWithCache(graphs: ReturnType<typeof flowIGs>, cache: PerceptionCache): number {
  let tokens = 0;
  for (const g of graphs) {
    const r = cache.resolve(ORIGIN, g);
    tokens += estimateTokens(JSON.stringify({ nodes: compactNodes(r.sentNodes), removed: r.removedIds }));
  }
  return tokens;
}

export interface CacheEvalResult {
  readonly coldNoCache: number;
  readonly warmNoCache: number;
  readonly coldWithCache: number;
  readonly warmWithCache: number;
  readonly totalNoCache: number;
  readonly totalWithCache: number;
  /** Warm-visit savings ratio (warmWithCache / warmNoCache) — < 1 means cheaper. */
  readonly warmRatio: number;
}

export function runCacheEval(): CacheEvalResult {
  // Two passes over the same origin/flow.
  const pass1 = flowIGs();
  const pass2 = flowIGs();

  // Without the cache: each pass pays the full per-step cost.
  const coldNoCache = passTokensNoCache(pass1);
  const warmNoCache = passTokensNoCache(pass2);

  // With the cache: pass 1 cold (origin unseen), pass 2 warm (revisit).
  const cache = new PerceptionCache();
  const coldWithCache = passTokensWithCache(pass1, cache);
  const warmWithCache = passTokensWithCache(pass2, cache);

  return {
    coldNoCache,
    warmNoCache,
    coldWithCache,
    warmWithCache,
    totalNoCache: coldNoCache + warmNoCache,
    totalWithCache: coldWithCache + warmWithCache,
    warmRatio: warmNoCache === 0 ? 1 : warmWithCache / warmNoCache,
  };
}

export function formatCacheReport(r: CacheEvalResult): string {
  const lines: string[] = [];
  lines.push("# Lattice perception-cache eval — repeated flow, cold vs warm (P2.2)\n");
  lines.push("Same 17-step flow run twice on one origin. The cache amortizes the stable-NodeId");
  lines.push("cost on the REVISIT; it does not reduce the cold first-visit cost.\n");
  lines.push("| Pass | no cache | with cache |");
  lines.push("|---|--:|--:|");
  lines.push(`| **COLD** (first visit) | ${r.coldNoCache} | ${r.coldWithCache} |`);
  lines.push(`| **WARM** (revisit) | ${r.warmNoCache} | ${r.warmWithCache} |`);
  lines.push(`| total | ${r.totalNoCache} | ${r.totalWithCache} |`);
  lines.push("");
  lines.push(`- COLD first visit still costs **${r.coldWithCache}** tokens WITH the cache — the agent must learn the whole skeleton (every unique NodeId) the first time. The cache does NOT make this free; that is the base cost. (It is below the ${r.coldNoCache} no-cache figure only because the union also avoids re-sending nodes that disappear and reappear WITHIN one pass — a separate, smaller effect.)`);
  lines.push(`- WARM revisit is where the cache pays off: ${r.warmNoCache} → **${r.warmWithCache}** tokens (**${r.warmRatio.toFixed(3)}×**). The skeleton is NOT re-sent; only genuine per-step changes are.`);
  lines.push(`- Cold and warm are separate numbers ON PURPOSE: the warm saving is amortization of repeat visits, NOT a reduction of the one-time base cost (${r.coldWithCache} is still paid cold).`);
  return lines.join("\n");
}
