/**
 * The two systems under comparison, run over identical scenarios:
 *
 *  - LATTICE: perceive → snapshotToIG (full IG on the first point, igDelta on
 *    later points), act by STABLE NodeId re-anchored to the current ref.
 *  - BARE agent-browser: consume the terse accessibility text each perceive
 *    point, act by re-finding the element by label in the current snapshot.
 *
 * To avoid strawmanning the baseline we measure agent-browser TWO ways:
 *  - ab_full: re-snapshot fully each perceive point (naive agent usage);
 *  - ab_diff: text line-diff on later points (agent-browser ships `diff`).
 * And we report the baseline's accuracy both when it re-finds (fair) and when it
 * naively caches refs (the failure mode Lattice's stable id prevents).
 */

import { snapshotToIG, igDelta, compactNodes, compactDelta } from "@lattice/perception";
import type { SnapshotIG } from "@lattice/perception";
import { estimateTokens } from "./tokens.js";
import { loadFrame, refByLabel } from "./fixtures.js";
import type { Scenario } from "./scenarios.js";

export interface SystemResult {
  readonly perceiveCount: number;
  readonly perceptionTokens: number;
  readonly actionsTotal: number;
  readonly actionsResolved: number;
  readonly accuracy: number; // actionsResolved / actionsTotal
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly lattice: SystemResult;
  readonly abFull: SystemResult;
  readonly abDiff: SystemResult;
  /** Baseline accuracy if it naively reused first-seen refs (no re-find). */
  readonly abNaiveAccuracy: number;
}

/** Simple line-level diff token cost: lines present in `next` but not `prev`. */
function lineDiffTokens(prev: string, next: string): number {
  const prevSet = new Set(prev.split("\n"));
  const added = next.split("\n").filter((l) => !prevSet.has(l));
  return estimateTokens(added.join("\n"));
}

// The COMPACT projection is the agent-facing wire shape (role + label, acted on
// by stable NodeId) — the same shape the gateway ships. We measure that, not the
// full internal node, because that is what the agent actually pays tokens for.
function serializeIG(ig: SnapshotIG): string {
  return JSON.stringify(compactNodes(ig.graph.nodes.values()));
}

export function runScenario(scenario: Scenario): ScenarioResult {
  const frames = scenario.steps.map((s) => loadFrame(s.frame));
  const igs = frames.map((f) => snapshotToIG(f.raw, { tier: "L1" }));

  // ── token cost ────────────────────────────────────────────────────────────
  let latticeTokens = 0;
  let abFullTokens = 0;
  let abDiffTokens = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    abFullTokens += estimateTokens(f.snapshotText);
    abDiffTokens += i === 0 ? estimateTokens(f.snapshotText) : lineDiffTokens(frames[i - 1]!.snapshotText, f.snapshotText);
    latticeTokens += i === 0 ? estimateTokens(serializeIG(igs[i]!)) : estimateTokens(JSON.stringify(compactDelta(igDelta(igs[i - 1]!.graph, igs[i]!.graph))));
  }

  // ── action resolution / accuracy ────────────────────────────────────────────
  let total = 0;
  let latticeOk = 0;
  let abFairOk = 0;
  let abNaiveOk = 0;
  // Naive baseline: remember the ref the FIRST time it saw each label.
  const cachedRef = new Map<string, string>();

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const frame = frames[i]!;
    const ig = igs[i]!;
    for (const target of step.targets) {
      total++;

      // Lattice: find the node by label, re-anchor to the current ref, verify it
      // points at the right element in THIS frame.
      const node = [...ig.graph.nodes.values()].find((n) => n.label === target);
      const latticeRef = node ? ig.refMap.get(node.id) : undefined;
      if (latticeRef && frame.refs[latticeRef]?.name === target) latticeOk++;

      // agent-browser fair: re-find by label in the current snapshot.
      const fairRef = refByLabel(frame, target);
      if (fairRef) abFairOk++;

      // agent-browser naive: reuse the first-seen ref; after a re-render it may
      // now point at a different element.
      if (!cachedRef.has(target)) {
        const r = refByLabel(frame, target);
        if (r) cachedRef.set(target, r);
      }
      const naive = cachedRef.get(target);
      if (naive && frame.refs[naive]?.name === target) abNaiveOk++;
    }
  }

  const perceiveCount = frames.length;
  const mk = (resolved: number): SystemResult => ({
    perceiveCount,
    perceptionTokens: 0,
    actionsTotal: total,
    actionsResolved: resolved,
    accuracy: total === 0 ? 1 : resolved / total,
  });

  return {
    scenario: scenario.name,
    lattice: { ...mk(latticeOk), perceptionTokens: latticeTokens },
    abFull: { ...mk(abFairOk), perceptionTokens: abFullTokens },
    abDiff: { ...mk(abFairOk), perceptionTokens: abDiffTokens },
    abNaiveAccuracy: total === 0 ? 1 : abNaiveOk / total,
  };
}
