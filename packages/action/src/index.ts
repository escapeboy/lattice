/**
 * @lattice/action — Semantic action engine (S0 scaffold; implementation in S3)
 */

import type { NodeId, IGDelta } from "@lattice/perception";

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
  nodeId: NodeId;
}

export type ActionCommand =
  | { type: "navigate"; url: string }
  | { type: "act"; target: ActionTarget }
  | { type: "fill"; target: ActionTarget; value: string }
  | { type: "select"; target: ActionTarget; value: string }
  | { type: "set"; target: ActionTarget; value: unknown }
  | { type: "submit"; target: ActionTarget }
  | { type: "scroll_to"; target: ActionTarget }
  | { type: "wait_for"; condition: WaitCondition }
  | { type: "extract"; query: string }
  | { type: "upload"; target: ActionTarget; filePath: string }
  | { type: "download"; target: ActionTarget };

export type WaitCondition =
  | { kind: "network_idle" }
  | { kind: "mutation_quiescence" }
  | { kind: "navigation_complete" };

export type ActionErrorCode =
  | "element_gone"
  | "obscured"
  | "disabled"
  | "navigation_interrupted"
  | "not_trusted"
  | "prohibited";

export class ActionError extends Error {
  constructor(
    public readonly code: ActionErrorCode,
    public readonly rePerceptionHint?: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface ActionResult {
  readonly success: boolean;
  readonly delta: IGDelta;
  readonly extracted?: unknown;
}

export interface ActionEngine {
  execute(command: ActionCommand): Promise<ActionResult>;
}

export function createActionEngine(): ActionEngine {
  throw new Error("Not implemented — see S3");
}
