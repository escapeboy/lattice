/**
 * Recovery eval (P2.1) — measures action success rate WITHOUT the recovery loop
 * (re-anchor by stable id only, one attempt) vs WITH the bounded ladder
 * (re-anchor → alt-locator → L3 vision → handoff).
 *
 * Each scenario perturbs a previously-located target between two real perceptions
 * (run through snapshotToIG, so the stable fingerprints are genuine, not mocked):
 *
 *   - moved        : sibling removed; refs shift but identity is unchanged.
 *   - restructured : wrapped in a new container; the fingerprint id changes but
 *                    role+label persist.
 *   - relabeled    : the accessible name changes; a11y identity is gone but the
 *                    control is still on screen.
 *   - disappeared  : the control is removed entirely.
 *
 * The honest framing: the baseline (re-anchor only) already handles "moved" — the
 * win agent-browser's per-snapshot refs miss. The ladder adds the other three:
 * two resolve, and the genuinely-gone one ESCALATES to a bounded handoff instead
 * of a blind retry loop.
 */

import { snapshotToIG } from "@lattice/perception";
import { locateInIG, runLadder } from "@lattice/action";
import type { RecoveryTarget, RecoveryRung } from "@lattice/action";
import type { NodeId } from "@lattice/perception";

function ig(tree: string) {
  return snapshotToIG({ url: "data:recovery", refs: [], tree }, { tier: "L1" });
}

interface RecoveryScenario {
  readonly name: string;
  readonly before: string;
  readonly after: string;
  readonly targetLabel: string;
  /** Is the control still visually on screen after the perturbation? (L3 rung) */
  readonly l3Locatable: boolean;
}

const SCENARIOS: ReadonlyArray<RecoveryScenario> = [
  {
    name: "moved",
    before: `- list "Items" [ref=e1]\n  - button "Remove me" [ref=e2]\n  - button "Save" [ref=e3]`,
    after: `- list "Items" [ref=e1]\n  - button "Save" [ref=e2]`,
    targetLabel: "Save",
    l3Locatable: true,
  },
  {
    name: "restructured",
    before: `- list "Items" [ref=e1]\n  - button "Save" [ref=e2]`,
    after: `- list "Items" [ref=e1]\n  - listitem "Row" [ref=e2]\n    - button "Save" [ref=e3]`,
    targetLabel: "Save",
    l3Locatable: true,
  },
  {
    name: "relabeled",
    before: `- list "Items" [ref=e1]\n  - button "Save" [ref=e2]`,
    after: `- list "Items" [ref=e1]\n  - button "Apply" [ref=e2]`,
    targetLabel: "Save",
    l3Locatable: true,
  },
  {
    name: "disappeared",
    before: `- list "Items" [ref=e1]\n  - button "Save" [ref=e2]`,
    after: `- list "Items" [ref=e1]\n  - button "Cancel" [ref=e2]`,
    targetLabel: "Save",
    l3Locatable: false,
  },
];

export interface RecoveryRowResult {
  readonly scenario: string;
  /** Baseline: re-anchor by stable id only — resolved this step? */
  readonly baselineResolved: boolean;
  /** With the ladder — resolved this step? */
  readonly recoveryResolved: boolean;
  /** With the ladder — escalated to a (bounded) human handoff? */
  readonly recoveryHandoff: boolean;
  /** Which ladder rung handled it. */
  readonly rung: RecoveryRung;
}

export interface RecoveryEvalResult {
  readonly rows: ReadonlyArray<RecoveryRowResult>;
  readonly baselineSuccess: number; // resolved / total
  readonly recoverySuccess: number; // resolved / total
  readonly recoveryHandoffs: number;
  readonly blindLoops: number; // always 0 — the ladder is single-pass by construction
}

export function runRecoveryEval(): RecoveryEvalResult {
  const rows = SCENARIOS.map((s): RecoveryRowResult => {
    const before = ig(s.before);
    const targetNode = [...before.graph.nodes.values()].find((n) => n.label === s.targetLabel);
    if (!targetNode) throw new Error(`recovery scenario ${s.name}: target not found in BEFORE`);
    const target: RecoveryTarget = {
      nodeId: targetNode.id,
      role: targetNode.role,
      label: targetNode.label,
      ...(targetNode.value !== undefined ? { value: targetNode.value } : {}),
    };

    const after = ig(s.after);
    const afterNodes = [...after.graph.nodes.values()].map((n) => ({
      id: n.id,
      role: n.role,
      label: n.label,
      ...(n.value !== undefined ? { value: n.value } : {}),
      ...(n.href !== undefined ? { href: n.href } : {}),
    }));
    const refFor = (id: NodeId) => after.refMap.get(id);

    // Baseline: re-anchor by stable id only, single attempt.
    const baselineResolved = refFor(target.nodeId) !== undefined;

    // With the bounded ladder.
    const located = locateInIG(target, afterNodes, refFor);
    const ladder = runLadder({ ...located, l3Locatable: s.l3Locatable });

    return {
      scenario: s.name,
      baselineResolved,
      recoveryResolved: ladder.outcome === "resolved",
      recoveryHandoff: ladder.outcome === "handoff",
      rung: ladder.rung,
    };
  });

  const total = rows.length;
  return {
    rows,
    baselineSuccess: rows.filter((r) => r.baselineResolved).length / total,
    recoverySuccess: rows.filter((r) => r.recoveryResolved).length / total,
    recoveryHandoffs: rows.filter((r) => r.recoveryHandoff).length,
    blindLoops: 0,
  };
}

export function formatRecoveryReport(r: RecoveryEvalResult): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push("# Lattice recovery eval — bounded ladder vs re-anchor only (P2.1)\n");
  lines.push("Action success when a located target is perturbed. BEFORE = re-anchor by stable");
  lines.push("id only (current behavior). AFTER = re-anchor → alt-locator → L3 vision → handoff.\n");
  lines.push("| Scenario | baseline resolves | recovery resolves | rung | handoff |");
  lines.push("|---|--:|--:|---|--:|");
  for (const row of r.rows) {
    lines.push(`| ${row.scenario} | ${row.baselineResolved ? "yes" : "no"} | ${row.recoveryResolved ? "yes" : "no"} | ${row.rung} | ${row.recoveryHandoff ? "yes" : "—"} |`);
  }
  lines.push("");
  lines.push(`- **BEFORE** (re-anchor only): success **${pct(r.baselineSuccess)}**`);
  lines.push(`- **AFTER** (bounded ladder): success **${pct(r.recoverySuccess)}** + ${r.recoveryHandoffs} graceful handoff(s)`);
  lines.push(`- Blind retry loops: **${r.blindLoops}** — the ladder is single-pass by construction (each rung at most once, terminal handoff).`);
  return lines.join("\n");
}
