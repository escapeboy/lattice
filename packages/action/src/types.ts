/**
 * Action Engine public types.
 */

import type { NodeId, IGDelta } from "@lattice/perception";

export type { NodeId };

export type ActionType =
  | "navigate"
  | "act"
  | "fill"
  | "select"
  | "set"
  | "submit"
  | "scroll_to"
  | "wait_for"
  | "extract"
  | "upload"
  | "download";

export interface ActionTarget {
  /** Stable IG node ID resolved from the Interaction Graph. */
  nodeId: NodeId;
}

export type WaitCondition =
  | { kind: "network_idle"; timeoutMs?: number }
  | { kind: "mutation_quiescence"; timeoutMs?: number }
  | { kind: "navigation_complete"; timeoutMs?: number };

export type ActionCommand =
  | { type: "navigate"; url: string }
  | { type: "act"; target: ActionTarget; intent?: string }
  | { type: "fill"; target: ActionTarget; value: string }
  | { type: "select"; target: ActionTarget; value: string }
  | { type: "set"; target: ActionTarget; value: unknown }
  | { type: "submit"; target: ActionTarget; intent?: string }
  | { type: "scroll_to"; target: ActionTarget }
  | { type: "wait_for"; condition: WaitCondition }
  | { type: "extract"; query: string }
  | { type: "upload"; target: ActionTarget; filePath: string }
  | { type: "download"; target: ActionTarget };

export type ActionErrorCode =
  | "element_gone"
  | "obscured"
  | "disabled"
  | "navigation_interrupted"
  | "not_trusted"
  | "prohibited"
  | "timeout"
  | "element_not_found";

export class ActionError extends Error {
  constructor(
    public readonly code: ActionErrorCode,
    public readonly rePerceptionHint?: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ActionError";
  }
}

export interface ActionResult {
  readonly success: boolean;
  readonly delta: IGDelta;
  readonly extracted?: unknown;
  /** URL after the action (may differ from before on navigation). */
  readonly url: string;
  /**
   * For `navigate`: `false` when the page did not settle within the bounded
   * budget (continuous-render canvas / infinite-scroll / polling). The action
   * still succeeded — perception should escalate to an L3 screenshot. Omitted
   * on a settled navigation and on non-navigate actions.
   */
  readonly settled?: boolean;
}

export interface ActionEngine {
  execute(command: ActionCommand): Promise<ActionResult>;
}
