/**
 * Measure the four systems under comparison on identical scenarios. The opponent
 * is the CHROME METHOD (screenshot / raw-DOM); agent-browser is a semantic-engine
 * PARITY reference, not the opponent.
 *
 *  - LATTICE: compact IG on the first perceive, compact delta on later perceives;
 *    act by STABLE NodeId re-anchored to the current ref.
 *  - AGENT-BROWSER (parity): terse a11y text, line-diff on later perceives (it
 *    ships `diff`); act by re-finding the label in the current snapshot.
 *  - SCREENSHOT (Chrome method): a fixed vision-token cost every perceive step
 *    (pixels can't be diffed for the model); acts by coordinates.
 *  - RAW-DOM (Chrome method): the serialized DOM every perceive step; acts by
 *    selector/xpath.
 *
 * Tokens are the gate vs the Chrome method. Accuracy is reported two ways: when
 * a system RE-PERCEIVES each step (all can reach 100% on present targets) and
 * when it NAIVELY caches an identifier to save tokens — the regime where
 * Lattice's stable identity beats agent-browser's per-snapshot refs.
 */

import { snapshotToIG, igDelta, compactNodes, compactDelta } from "@lattice/perception";
import type { SnapshotIG } from "@lattice/perception";
import { estimateTokens } from "./tokens.js";
import { refByLabel, SCREENSHOT_TOKENS } from "./frame.js";
import type { EvalFrame } from "./frame.js";
import type { ResolvedScenario } from "./scenarios.js";

export interface SystemResult {
  readonly perceiveCount: number;
  readonly perceptionTokens: number;
  readonly actionsTotal: number;
  readonly actionsResolved: number;
  readonly accuracy: number; // re-perceiving accuracy
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly steps: number;
  readonly lattice: SystemResult;
  readonly agentBrowser: SystemResult;
  readonly screenshot: SystemResult;
  readonly rawDom: SystemResult;
  /** Raw-DOM if it diffed the serialized DOM instead of re-feeding it (transparency). */
  readonly rawDomDiffTokens: number;
  /** Accuracy when caching an id to skip re-find: Lattice stable id stays valid. */
  readonly latticeNaiveAccuracy: number;
  /** Accuracy when caching a ref to skip re-find: agent-browser refs churn. */
  readonly abNaiveAccuracy: number;
}

/** Line-level diff token cost: lines present in `next` but not `prev`. */
function lineDiffTokens(prev: string, next: string): number {
  const prevSet = new Set(prev.split("\n"));
  const added = next.split("\n").filter((l) => !prevSet.has(l));
  return estimateTokens(added.join("\n"));
}

/** Compact IG (the agent-facing wire shape), what the agent pays tokens for. */
function serializeIG(ig: SnapshotIG): string {
  return JSON.stringify(compactNodes(ig.graph.nodes.values()));
}

function mk(perceiveCount: number, perceptionTokens: number, total: number, resolved: number): SystemResult {
  return {
    perceiveCount,
    perceptionTokens,
    actionsTotal: total,
    actionsResolved: resolved,
    accuracy: total === 0 ? 1 : resolved / total,
  };
}

export function runScenario(scenario: ResolvedScenario): ScenarioResult {
  const frames: ReadonlyArray<EvalFrame> = scenario.frames;
  const igs = frames.map((f) => snapshotToIG(f.raw, { tier: "L1" }));

  // ── token cost ──────────────────────────────────────────────────────────────
  let latticeTokens = 0;
  let abTokens = 0;
  let screenshotTokens = 0;
  let rawDomTokens = 0;
  let rawDomDiffTokens = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const prevText = i === 0 ? "" : frames[i - 1]!.snapshotText;
    const prevHtml = i === 0 ? "" : frames[i - 1]!.html;

    latticeTokens += i === 0 ? estimateTokens(serializeIG(igs[i]!)) : estimateTokens(JSON.stringify(compactDelta(igDelta(igs[i - 1]!.graph, igs[i]!.graph))));
    abTokens += i === 0 ? estimateTokens(f.snapshotText) : lineDiffTokens(prevText, f.snapshotText);
    screenshotTokens += SCREENSHOT_TOKENS; // paid in full every step
    rawDomTokens += estimateTokens(f.html); // re-fed every step (Chrome-method practice)
    rawDomDiffTokens += i === 0 ? estimateTokens(f.html) : lineDiffTokens(prevHtml, f.html);
  }

  // ── action resolution / accuracy ──────────────────────────────────────────────
  let total = 0;
  let latticeOk = 0;
  let abFairOk = 0;
  let chromeOk = 0; // screenshot + raw-DOM re-perceive: present target → resolved
  let latticeNaiveOk = 0;
  let abNaiveOk = 0;
  const cachedRef = new Map<string, string>();
  const cachedNodeId = new Map<string, string>();

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const ig = igs[i]!;
    for (const target of scenario.targets[i] ?? []) {
      total++;

      // Lattice: find by label, re-anchor stable id → current ref, verify.
      const node = [...ig.graph.nodes.values()].find((n) => n.label === target);
      const latticeRef = node ? ig.refMap.get(node.id) : undefined;
      if (latticeRef && frame.refs[latticeRef]?.name === target) latticeOk++;

      // agent-browser fair: re-find the label in the current snapshot.
      if (refByLabel(frame, target)) abFairOk++;

      // screenshot / raw-DOM re-perceiving: the target is present this frame.
      if (refByLabel(frame, target)) chromeOk++;

      // Naive (cache to skip re-find): Lattice caches the STABLE id, agent-browser
      // caches the volatile ref.
      if (node && !cachedNodeId.has(target)) cachedNodeId.set(target, node.id);
      const cachedId = cachedNodeId.get(target);
      const reRef = cachedId ? ig.refMap.get(cachedId as never) : undefined;
      if (reRef && frame.refs[reRef]?.name === target) latticeNaiveOk++;

      if (!cachedRef.has(target)) {
        const r = refByLabel(frame, target);
        if (r) cachedRef.set(target, r);
      }
      const naiveRef = cachedRef.get(target);
      if (naiveRef && frame.refs[naiveRef]?.name === target) abNaiveOk++;
    }
  }

  const n = frames.length;
  return {
    scenario: scenario.name,
    steps: n,
    lattice: mk(n, latticeTokens, total, latticeOk),
    agentBrowser: mk(n, abTokens, total, abFairOk),
    screenshot: mk(n, screenshotTokens, total, chromeOk),
    rawDom: mk(n, rawDomTokens, total, chromeOk),
    rawDomDiffTokens,
    latticeNaiveAccuracy: total === 0 ? 1 : latticeNaiveOk / total,
    abNaiveAccuracy: total === 0 ? 1 : abNaiveOk / total,
  };
}
