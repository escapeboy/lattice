/**
 * @lattice/perception — Interaction Graph engine (S0 scaffold; implementation in S2)
 */

export type NodeId = string & { readonly __brand: "NodeId" };

export type FidelityTier = "L0" | "L1" | "L2" | "L3";

export type NodeRole =
  | "button"
  | "link"
  | "input"
  | "select"
  | "textarea"
  | "checkbox"
  | "radio"
  | "combobox"
  | "heading"
  | "landmark"
  | "generic";

export interface IGNode {
  readonly id: NodeId;
  readonly role: NodeRole;
  readonly label: string;
  readonly state: {
    readonly disabled: boolean;
    readonly hidden: boolean;
    readonly checked?: boolean;
    readonly expanded?: boolean;
  };
  readonly value?: string;
  readonly relations: ReadonlyArray<{ type: "labelled-by" | "controls" | "owns"; targetId: NodeId }>;
  readonly geometry?: { x: number; y: number; width: number; height: number };
}

export interface InteractionGraph {
  readonly tier: FidelityTier;
  readonly nodes: ReadonlyMap<NodeId, IGNode>;
  readonly serializedSize: number;
}

export interface IGDelta {
  readonly added: ReadonlyArray<IGNode>;
  readonly removed: ReadonlyArray<NodeId>;
  readonly updated: ReadonlyArray<IGNode>;
}

export interface PerceptionEngine {
  snapshot(tier: FidelityTier): Promise<InteractionGraph>;
  delta(prev: InteractionGraph, next: InteractionGraph): IGDelta;
}

export function createPerceptionEngine(): PerceptionEngine {
  throw new Error("Not implemented — see S2");
}
