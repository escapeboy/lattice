/**
 * S2 build-on perception (ADR 0002): turn an agent-browser accessibility
 * snapshot into the Lattice Interaction Graph, adding the three things
 * agent-browser does NOT give us — and which are the differentiation:
 *
 *  1. Cross-mutation stable identity. agent-browser's refs (e1, e2, …) are valid
 *     only within ONE snapshot; the same button gets a different ref after a
 *     re-render. We compute a NodeId from the SEMANTIC fingerprint
 *     (role + name + ancestor path + ordinal) via the shared `computeNodeId`,
 *     so the id is stable across mutation. The volatile ref is kept in a
 *     re-anchoring map (stable NodeId → current ref) so actions still resolve.
 *  2. Taint metadata per node. Every node here is page-origin observation, so
 *     every node is tainted by construction — carried as metadata the gateway
 *     delivers in the quarantined channel (architecture §6).
 *  3. Streamed deltas. `igDelta` computes added/removed/updated by stable id
 *     between consecutive snapshots — the basis for delta streaming, not just a
 *     one-off diff.
 */

import { computeNodeId } from "./identity.js";
import type {
  IGDelta,
  IGNode,
  InteractionGraph,
  NodeId,
  NodeRole,
} from "./types.js";
import type { RawSnapshot } from "@lattice/engine-adapter";

/** agent-browser snapshot roles (ARIA-ish) → Lattice NodeRole. */
const ROLE_MAP: Record<string, NodeRole> = {
  button: "button",
  link: "link",
  textbox: "input",
  searchbox: "input",
  spinbutton: "input",
  combobox: "combobox",
  listbox: "select",
  textarea: "textarea",
  checkbox: "checkbox",
  switch: "checkbox",
  radio: "radio",
  heading: "heading",
  navigation: "landmark",
  main: "landmark",
  banner: "landmark",
  contentinfo: "landmark",
  complementary: "landmark",
  region: "landmark",
  search: "landmark",
  list: "list",
  listitem: "listitem",
  dialog: "dialog",
  alertdialog: "dialog",
  alert: "alert",
  tab: "tab",
  tabpanel: "tabpanel",
  menu: "menu",
  menuitem: "menuitem",
  img: "image",
  image: "image",
  // Structural / content roles (smoke gap #1b) — non-interactive, so they appear
  // on L2 (full content) but are filtered out of L1. Table/grid cells, docs
  // prose/code, and iframe boundaries were previously dropped silently (up to
  // ~28% of nodes on table-heavy pages; iframe = consent/payment frames).
  table: "table",
  grid: "table",
  row: "row",
  cell: "cell",
  gridcell: "cell",
  columnheader: "cell",
  rowheader: "cell",
  article: "article",
  code: "code",
  paragraph: "text",
  iframe: "iframe",
};

const INTERACTIVE_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>([
  "button",
  "link",
  "input",
  "select",
  "textarea",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
]);

interface ParsedLine {
  depth: number;
  rawRole: string;
  name: string;
  ref: string | undefined;
  flags: Set<string>;
}

const LINE_RE = /^(\s*)-\s+([^\s"[]+)(?:\s+"([^"]*)")?(.*)$/;

/** Parse agent-browser's indented tree text into structured lines. */
export function parseSnapshotTree(tree: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of tree.split("\n")) {
    if (raw.trim() === "") continue;
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const indent = m[1] ?? "";
    const rawRole = (m[2] ?? "").toLowerCase();
    const name = m[3] ?? "";
    const rest = m[4] ?? "";
    const refMatch = /\[ref=(e\d+)\]/.exec(rest);
    const flags = new Set<string>();
    for (const fm of rest.matchAll(/\[([a-z]+)\]/g)) {
      const f = fm[1];
      if (f && f !== "ref") flags.add(f);
    }
    lines.push({
      depth: indent.length,
      rawRole,
      name,
      ref: refMatch?.[1],
      flags,
    });
  }
  return lines;
}

/** Per-node taint mark. All page-origin nodes are tainted by construction. */
export interface TaintMark {
  readonly origin: "page-content";
  /** The label/value bytes that must stay in the quarantined channel. */
  readonly fields: ReadonlyArray<"label" | "value">;
}

export interface SnapshotIG {
  readonly graph: InteractionGraph;
  /** Every node is page-origin → tainted. The gateway delivers these quarantined. */
  readonly taint: ReadonlyMap<NodeId, TaintMark>;
  /** Re-anchoring: stable NodeId → the volatile agent-browser ref in THIS snapshot. */
  readonly refMap: ReadonlyMap<NodeId, string>;
}

export interface SnapshotIGOptions {
  /** L2 keeps all roles; L1 (default) keeps interactive + heading + landmark. */
  tier?: "L1" | "L2";
  title?: string;
}

/**
 * Build a Lattice IG from an agent-browser RawSnapshot. The volatile ref is used
 * ONLY for re-anchoring; identity is the semantic fingerprint, so the same
 * element keeps its NodeId across re-renders even when its ref changes.
 */
export function snapshotToIG(raw: RawSnapshot, opts: SnapshotIGOptions = {}): SnapshotIG {
  const tier = opts.tier ?? "L1";
  const lines = parseSnapshotTree(raw.tree);

  // Ancestry stack keyed by indentation depth → ancestor Lattice roles.
  const stack: Array<{ depth: number; role: NodeRole }> = [];
  const ordinalTracker = new Map<string, number>();

  const nodes = new Map<NodeId, IGNode>();
  const nodeOrder: NodeId[] = [];
  const taint = new Map<NodeId, TaintMark>();
  const refMap = new Map<NodeId, string>();

  for (const line of lines) {
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= line.depth) {
      stack.pop();
    }
    const role = ROLE_MAP[line.rawRole] ?? null;
    if (!role) {
      // Unknown/structural role — does not contribute a node but still nests.
      continue;
    }
    const ancestorRoles = stack.map((s) => s.role);
    stack.push({ depth: line.depth, role });

    if (tier === "L1" && !INTERACTIVE_ROLES.has(role) && role !== "heading" && role !== "landmark") {
      continue;
    }

    const label = line.name;
    const ordinalKey = `${role}:${label.toLowerCase().trim()}`;
    const ordinal = ordinalTracker.get(ordinalKey) ?? 0;
    ordinalTracker.set(ordinalKey, ordinal + 1);

    // No backendDOMNodeId: identity falls to the semantic fingerprint, which is
    // exactly what survives agent-browser's per-snapshot ref churn.
    const id = computeNodeId({ role, axName: label, ancestorRoles, ordinal }) as NodeId;
    if (nodes.has(id)) continue; // fingerprint collision within one snapshot — keep first

    const node: IGNode = {
      id,
      role,
      label,
      state: {
        disabled: line.flags.has("disabled"),
        hidden: false,
        ...(line.flags.has("checked") ? { checked: true } : {}),
        ...(line.flags.has("expanded") ? { expanded: true } : {}),
        ...(line.flags.has("selected") ? { selected: true } : {}),
        ...(line.flags.has("required") ? { required: true } : {}),
        ...(line.flags.has("readonly") ? { readonly: true } : {}),
      },
      relations: [],
      ...(label ? { axName: label } : {}),
    };
    nodes.set(id, node);
    nodeOrder.push(id);
    taint.set(id, { origin: "page-content", fields: label ? ["label"] : [] });
    if (line.ref) refMap.set(id, line.ref);
  }

  const serialized = JSON.stringify({
    url: raw.url,
    title: opts.title ?? "",
    nodes: Array.from(nodes.values()),
  });

  const graph: InteractionGraph = {
    tier,
    url: raw.url,
    title: opts.title ?? "",
    nodes,
    nodeOrder,
    serializedSize: Buffer.byteLength(serialized, "utf8"),
  };
  return { graph, taint, refMap };
}

/**
 * Delta between two IGs by stable NodeId — the unit of delta streaming. Because
 * ids are mutation-stable, a re-render that only changes agent-browser refs
 * produces an EMPTY delta here, where their snapshot diff would show churn.
 */
export function igDelta(prev: InteractionGraph, next: InteractionGraph): IGDelta {
  const added: IGNode[] = [];
  const removed: NodeId[] = [];
  const updated: IGNode[] = [];

  for (const [id, nextNode] of next.nodes) {
    const prevNode = prev.nodes.get(id);
    if (!prevNode) added.push(nextNode);
    else if (JSON.stringify(prevNode) !== JSON.stringify(nextNode)) updated.push(nextNode);
  }
  for (const id of prev.nodes.keys()) {
    if (!next.nodes.has(id)) removed.push(id);
  }
  return { added, removed, updated };
}
