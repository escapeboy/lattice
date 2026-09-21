/**
 * Indexed element table built from an L1 Interaction Graph.
 *
 * The table is the ONLY bridge between the page and the model. Its page-derived
 * halves (label / value / placeholder) go into the Jev request's `state`; its
 * index + role halves are the only things allowed to become question criteria.
 * `taint.ts` enforces that split.
 */

import type { IGNode, InteractionGraph, NodeId, NodeRole } from "@lattice/perception";

export type Operation =
  | "CLICK"
  | "TYPE_TEXT"
  | "SELECT"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

/** Operations that aim at a specific element, each with its own target head. */
export const TARGETED_OPERATIONS = ["CLICK", "TYPE_TEXT", "SELECT"] as const;
export type TargetedOperation = (typeof TARGETED_OPERATIONS)[number];

/** Jev caps a Choice at 255 options; one slot is reserved for "other". */
export const MAX_OPTIONS = 255;
const MAX_TARGETS = MAX_OPTIONS - 1;

const CLICKABLE: ReadonlySet<NodeRole> = new Set<NodeRole>([
  "button",
  "link",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "combobox",
]);

const TYPEABLE: ReadonlySet<NodeRole> = new Set<NodeRole>(["input", "textarea", "combobox"]);

const SELECTABLE: ReadonlySet<NodeRole> = new Set<NodeRole>(["select"]);

export interface IndexedElement {
  /** 1-based. The only element identifier the model ever sees. */
  readonly index: number;
  /** Never sent to the model. Code resolves the action against this node. */
  readonly nodeId: NodeId;
  /** Closed vocabulary from the a11y tree — a classification, not page text. */
  readonly role: NodeRole;
  /** PAGE-DERIVED. `state` only. */
  readonly label: string;
  /** PAGE-DERIVED. `state` only. */
  readonly value?: string;
  /** PAGE-DERIVED. `state` only. */
  readonly placeholder?: string;
  /** Target heads this element is a valid option for. */
  readonly operations: readonly TargetedOperation[];
  /** True when the node's box intersects the viewport (not just near it). */
  readonly inViewport: boolean;
  /** False when the node has no layout box (detached / display:none). */
  readonly positionKnown: boolean;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Document scroll offset, so geometry can be compared against the viewport. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** Full document height, so an impossible scroll is never offered. */
  readonly scrollHeight: number;
}

function operationsFor(node: IGNode): TargetedOperation[] {
  const ops: TargetedOperation[] = [];
  if (CLICKABLE.has(node.role)) ops.push("CLICK");
  if (TYPEABLE.has(node.role) && node.state.readonly !== true) ops.push("TYPE_TEXT");
  if (SELECTABLE.has(node.role)) ops.push("SELECT");
  return ops;
}

/**
 * A node whose position is unknown is still eligible — dropping it would
 * silently empty the action space, which is what a strict viewport filter did
 * on the first run, when L1 carried no geometry at all.
 *
 * L1 now DOES carry geometry (the actuator fix put it there, from the DOM
 * snapshot that was already being taken). It is viewport-relative, in the same
 * frame as `Input.dispatchMouseEvent`, so the scroll offset must NOT be
 * subtracted again — doing that double-counted the scroll and pushed
 * everything below the fold out of the table.
 */
const POSITION_UNKNOWN = Number.POSITIVE_INFINITY;

/** Distance in CSS pixels from the viewport box. 0 when the node intersects it. */
function viewportDistance(node: IGNode, vp: Viewport): number {
  const g = node.geometry;
  if (!g) return POSITION_UNKNOWN;
  const top = g.y;
  const bottom = top + g.height;
  const left = g.x;
  const right = left + g.width;
  const dy = top > vp.height ? top - vp.height : bottom < 0 ? -bottom : 0;
  const dx = left > vp.width ? left - vp.width : right < 0 ? -right : 0;
  return Math.hypot(dx, dy);
}

export interface ElementTable {
  readonly elements: readonly IndexedElement[];
  /** index -> node, for executing against the observed node. */
  readonly byIndex: ReadonlyMap<number, IndexedElement>;
  /** Operations that currently have at least one valid target. */
  readonly availableTargeted: readonly TargetedOperation[];
  /** How many interactable nodes were dropped by the 255 cap. */
  readonly truncated: number;
  /** Scrolling up is only an option when there is something above the fold. */
  readonly canScrollUp: boolean;
  readonly canScrollDown: boolean;
}

/**
 * Build the table from interactable nodes in or near the viewport.
 *
 * `nearMargin` is one viewport height by default: a control just below the fold
 * is a legitimate SCROLL_DOWN-then-click target, so it belongs in the table.
 */
export function buildElementTable(
  ig: InteractionGraph,
  vp: Viewport,
  nearMargin = vp.height,
): ElementTable {
  const candidates: { node: IGNode; ops: TargetedOperation[]; distance: number }[] = [];

  for (const nodeId of ig.nodeOrder) {
    const node = ig.nodes.get(nodeId);
    if (!node) continue;
    if (node.state.hidden || node.state.disabled) continue;
    const ops = operationsFor(node);
    if (ops.length === 0) continue;
    const distance = viewportDistance(node, vp);
    // A known position beyond the near margin is off-task; an unknown position
    // is kept, and sorts after everything whose position we do know.
    if (distance !== POSITION_UNKNOWN && distance > nearMargin) continue;
    candidates.push({ node, ops, distance });
  }

  // In-viewport first, then nearest, then unknown-position; document order
  // breaks ties (stable sort).
  candidates.sort((a, b) => a.distance - b.distance);

  const kept = candidates.slice(0, MAX_TARGETS);
  const elements: IndexedElement[] = kept.map((c, i) => ({
    index: i + 1,
    nodeId: c.node.id,
    role: c.node.role,
    label: c.node.label,
    ...(c.node.value !== undefined ? { value: c.node.value } : {}),
    ...(c.node.placeholder !== undefined ? { placeholder: c.node.placeholder } : {}),
    operations: c.ops,
    inViewport: c.distance === 0,
    positionKnown: c.distance !== POSITION_UNKNOWN,
  }));

  const byIndex = new Map(elements.map((e) => [e.index, e]));
  const availableTargeted = TARGETED_OPERATIONS.filter((op) =>
    elements.some((e) => e.operations.includes(op)),
  );

  return {
    elements,
    byIndex,
    availableTargeted,
    truncated: candidates.length - kept.length,
    // Same rule as the target heads: an operation with no valid move is not
    // offered. At the top of a short page SCROLL_UP and SCROLL_DOWN are both
    // impossible, and offering them drains probability mass from the real
    // options — measured on the first live run.
    canScrollUp: vp.scrollY > 1,
    canScrollDown: vp.scrollY + vp.height < vp.scrollHeight - 1,
  };
}

/** The page-derived half of the table — this is what goes into `state`. */
export function stateRows(table: ElementTable): Array<Record<string, unknown>> {
  return table.elements.map((e) => ({
    index: e.index,
    role: e.role,
    label: e.label,
    ...(e.value !== undefined ? { value: e.value } : {}),
    ...(e.placeholder !== undefined ? { placeholder: e.placeholder } : {}),
    in_viewport: e.inViewport,
  }));
}
