/**
 * Perception Engine public types.
 * Interaction Graph (IG) is the canonical semantic representation of a page.
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
  | "list"
  | "listitem"
  | "dialog"
  | "alert"
  | "tab"
  | "tabpanel"
  | "menu"
  | "menuitem"
  | "image"
  | "generic";

export interface NodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeRelation {
  type: "labelled-by" | "controls" | "owns" | "described-by";
  targetId: NodeId;
}

export interface IGNode {
  readonly id: NodeId;
  readonly role: NodeRole;
  readonly label: string;
  readonly state: {
    readonly disabled: boolean;
    readonly hidden: boolean;
    readonly checked?: boolean;
    readonly expanded?: boolean;
    readonly selected?: boolean;
    readonly required?: boolean;
    readonly readonly?: boolean;
  };
  readonly value?: string;
  readonly placeholder?: string;
  readonly href?: string;
  readonly level?: number;
  readonly relations: ReadonlyArray<NodeRelation>;
  readonly geometry?: NodeGeometry;
  /** Raw accessible name for debugging */
  readonly axName?: string;
}

/** L0: just a structural summary (counts, title, url) */
export interface L0Summary {
  readonly tier: "L0";
  readonly url: string;
  readonly title: string;
  readonly interactiveCount: number;
  readonly landmarkCount: number;
}

/** L1: Interaction Graph — default tier */
export interface InteractionGraph {
  readonly tier: "L1" | "L2";
  readonly url: string;
  readonly title: string;
  readonly nodes: ReadonlyMap<NodeId, IGNode>;
  readonly nodeOrder: ReadonlyArray<NodeId>;
  readonly serializedSize: number;
}

export type PerceptionSnapshot = L0Summary | InteractionGraph;

export interface IGDelta {
  readonly added: ReadonlyArray<IGNode>;
  readonly removed: ReadonlyArray<NodeId>;
  readonly updated: ReadonlyArray<IGNode>;
}

export interface PerceptionEngine {
  snapshot(tier: FidelityTier): Promise<PerceptionSnapshot>;
  delta(prev: InteractionGraph, next: InteractionGraph): IGDelta;
}
