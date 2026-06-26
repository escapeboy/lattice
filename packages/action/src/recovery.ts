/**
 * Bounded failure-recovery ladder (P2.1).
 *
 * Typed action errors tell us an action failed; without a strategy an agent
 * retries blindly and loops. This is the strategy: a fixed, ordered ladder where
 * each rung is tried AT MOST ONCE, then we stop. No blind retry, no looping.
 *
 *   1. re-perceive → re-anchor : the stable NodeId still resolves after a
 *      re-render/move (the case agent-browser's per-snapshot refs miss).
 *   2. alternative locator     : identity shifted (restructured ancestry) but a
 *      semantic attribute persists — find by role + label (or value/href).
 *   3. L3 vision               : a11y identity is gone (relabeled) but the
 *      control is still on screen — a vision model locates it by pixels.
 *   4. handoff                 : truly gone / ambiguous — escalate to a human,
 *      bounded, instead of thrashing.
 *
 * The ladder itself is a pure decision (`runLadder`) so it is deterministic and
 * testable; `RecoveryExecutor` drives the async re-perceive/locate/escalate
 * steps around it and enforces the single-pass bound.
 */

import type { NodeId } from "@lattice/perception";

export type RecoveryRung = "reanchor" | "alt_locator" | "l3_vision" | "handoff";
export type RecoveryOutcome = "resolved" | "handoff";

/** What we know about the element we are trying to re-locate. */
export interface RecoveryTarget {
  readonly nodeId: NodeId;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
}

/** Pre-computed locate results for each rung, from one fresh perception. */
export interface LadderInputs {
  /** Current ref for the stable NodeId, if it still resolves (rung 1). */
  readonly reanchorRef?: string | undefined;
  /** Current ref of a role+attribute match, if identity shifted (rung 2). */
  readonly altLocatorRef?: string | undefined;
  /** Whether a vision pass can still see the control on screen (rung 3). */
  readonly l3Locatable?: boolean;
}

export interface LadderResult {
  readonly outcome: RecoveryOutcome;
  readonly rung: RecoveryRung;
  /** The a11y ref to act on, when resolved via rung 1 or 2 (vision uses coords). */
  readonly ref?: string;
}

/**
 * Decide the recovery outcome from one perception's locate results. Pure, total,
 * single-pass: the first rung that locates the element wins; otherwise handoff.
 */
export function runLadder(inputs: LadderInputs): LadderResult {
  if (inputs.reanchorRef) return { outcome: "resolved", rung: "reanchor", ref: inputs.reanchorRef };
  if (inputs.altLocatorRef) return { outcome: "resolved", rung: "alt_locator", ref: inputs.altLocatorRef };
  if (inputs.l3Locatable) return { outcome: "resolved", rung: "l3_vision" };
  return { outcome: "handoff", rung: "handoff" };
}

/** A minimal node view the alt-locator searches over. */
export interface LocatableNode {
  readonly id: NodeId;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly href?: string;
}

/**
 * Compute the rung-1 and rung-2 locate results over a freshly perceived node set
 * and its ref map. Rung 2 matches on a semantic attribute the rename/restructure
 * is unlikely to have changed, role-scoped to avoid cross-type collisions.
 */
export function locateInIG(
  target: RecoveryTarget,
  nodes: ReadonlyArray<LocatableNode>,
  refFor: (id: NodeId) => string | undefined,
): { reanchorRef?: string; altLocatorRef?: string } {
  const reanchorRef = refFor(target.nodeId);
  if (reanchorRef) return { reanchorRef };

  // Rung 2: same role AND a matching attribute (label, else value, else href).
  const alt = nodes.find(
    (n) =>
      n.role === target.role &&
      (n.label === target.label ||
        (target.value !== undefined && n.value === target.value) ||
        (n.href !== undefined && target.label !== "" && n.label === target.label)),
  );
  const altLocatorRef = alt ? refFor(alt.id) : undefined;
  return { ...(altLocatorRef ? { altLocatorRef } : {}) };
}

export interface RecoveryDeps {
  /** Re-perceive L1 and return the rung-1/2 locate inputs for the target. */
  readonly relocate: (target: RecoveryTarget) => Promise<{ reanchorRef?: string; altLocatorRef?: string }>;
  /** Perceive L3 (screenshot) and report whether the control is visually present. */
  readonly l3Locate: (target: RecoveryTarget) => Promise<boolean>;
  /** Raise a human handoff (terminal rung). */
  readonly handoff: (target: RecoveryTarget, reason: string) => Promise<void>;
}

/**
 * Drives one bounded pass of the ladder around the pure decision. Each rung's
 * async work runs at most once; there is no retry loop, so recovery always
 * terminates in `resolved` or `handoff`.
 */
export class RecoveryExecutor {
  constructor(private readonly deps: RecoveryDeps) {}

  async recover(target: RecoveryTarget, reason: string): Promise<LadderResult> {
    const { reanchorRef, altLocatorRef } = await this.deps.relocate(target);
    if (reanchorRef || altLocatorRef) {
      return runLadder({ reanchorRef, altLocatorRef });
    }
    const l3Locatable = await this.deps.l3Locate(target);
    if (l3Locatable) return runLadder({ l3Locatable });
    await this.deps.handoff(target, reason);
    return runLadder({});
  }
}
