/**
 * CDP Accessibility tree crawler.
 * Uses Accessibility.getFullAXTree to build raw nodes, then maps to IGNodes.
 */

import type { CDPHandle } from "@lattice/engine";
import { computeNodeId } from "./identity.js";
import type { IGNode, InteractionGraph, NodeGeometry, NodeId, NodeRole, NodeRelation } from "./types.js";

// ── CDP types (subset of Accessibility domain) ──────────────────────────────

interface AXValue {
  type: string;
  value?: string | boolean | number;
  relatedNodes?: Array<{ backendDOMNodeId?: number; nodeId?: string }>;
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

interface GetFullAXTreeResult {
  nodes: AXNode[];
}

interface GetBoxModelResult {
  model: {
    border: number[];
  };
}

interface DomSnapshotResult {
  documents: Array<{
    nodes: {
      backendNodeId: number[];
      attributes: number[][];
      isClickable?: { index: number[] };
    };
  }>;
  strings: string[];
}

// ── Role mapping ──────────────────────────────────────────────────────────────

const ROLE_MAP: Record<string, NodeRole> = {
  button: "button",
  link: "link",
  textbox: "input",
  "search box": "input",
  "password field": "input",
  "spin button": "input",
  listbox: "select",
  combobox: "combobox",
  textarea: "textarea",
  checkbox: "checkbox",
  "radio button": "radio",
  switch: "checkbox",
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
  "menu item": "menuitem",
  menuitemcheckbox: "menuitem",
  menuitemradio: "menuitem",
  img: "image",
  image: "image",
};

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
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

function mapRole(rawRole?: string): NodeRole | null {
  if (!rawRole) return null;
  const lower = rawRole.toLowerCase();
  return ROLE_MAP[lower] ?? null;
}

function getBoolProp(props: Array<{ name: string; value: AXValue }> | undefined, name: string): boolean {
  if (!props) return false;
  const prop = props.find((p) => p.name === name);
  return prop?.value.value === true || prop?.value.value === "true";
}

function getStringProp(props: Array<{ name: string; value: AXValue }> | undefined, name: string): string | undefined {
  if (!props) return undefined;
  const prop = props.find((p) => p.name === name);
  const v = prop?.value.value;
  return typeof v === "string" ? v : undefined;
}

/** AX numeric properties (e.g. heading "level") arrive as integers, not strings. */
function getNumberProp(props: Array<{ name: string; value: AXValue }> | undefined, name: string): number | undefined {
  if (!props) return undefined;
  const prop = props.find((p) => p.name === name);
  const v = prop?.value.value;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ── Geometry fetching (optional — L2 only) ──────────────────────────────────

async function fetchGeometry(cdp: CDPHandle, backendNodeId: number): Promise<NodeGeometry | undefined> {
  try {
    const result = await cdp.send<GetBoxModelResult>("DOM.getBoxModel", {
      backendNodeId,
    });
    const b = result.model.border;
    if (!b || b.length < 8) return undefined;
    const x = b[0] ?? 0;
    const y = b[1] ?? 0;
    const width = (b[2] ?? 0) - x;
    const height = (b[7] ?? 0) - y;
    return { x, y, width, height };
  } catch {
    return undefined;
  }
}

// ── DOM enrichment (one snapshot for the whole page) ─────────────────────────

interface DomEnrichment {
  /** Chrome's own click-target heuristic (handler / role / pointer). */
  readonly clickable: boolean;
  /** Has tabindex >= 0 — keyboard-focusable even without a semantic role. */
  readonly focusable: boolean;
  readonly href?: string;
}

/**
 * One DOMSnapshot.captureSnapshot for the whole page, keyed by backendNodeId.
 * Replaces the old per-link 3-call href dance (DOM.getDocument +
 * pushNodesByBackendIdsToFrontend + getAttributes × N links) with a single
 * round-trip, and supplies the clickability signal that lets us recover
 * role-less but interactive elements (div-soup UIs) the AX tree leaves generic.
 */
async function captureDomEnrichment(cdp: CDPHandle): Promise<Map<number, DomEnrichment>> {
  const map = new Map<number, DomEnrichment>();
  try {
    const snap = await cdp.send<DomSnapshotResult>("DOMSnapshot.captureSnapshot", { computedStyles: [] });
    const doc = snap.documents[0];
    if (!doc) return map;
    const { strings } = snap;
    const clickable = new Set(doc.nodes.isClickable?.index ?? []);
    const beIds = doc.nodes.backendNodeId;
    const attrsArr = doc.nodes.attributes;

    for (let i = 0; i < beIds.length; i++) {
      const beId = beIds[i];
      if (beId === undefined || beId < 0) continue;
      const attrs = attrsArr[i] ?? [];
      let href: string | undefined;
      let focusable = false;
      for (let a = 0; a + 1 < attrs.length; a += 2) {
        const name = strings[attrs[a]!];
        const val = strings[attrs[a + 1]!];
        if (name === "href") href = val;
        else if (name === "tabindex" && val !== undefined && Number(val) >= 0) focusable = true;
      }
      map.set(beId, { clickable: clickable.has(i), focusable, ...(href !== undefined ? { href } : {}) });
    }
  } catch {
    // DOMSnapshot unavailable — degrade to a11y-only (no href / clickability).
  }
  return map;
}

// ── Main IG builder ──────────────────────────────────────────────────────────

export async function buildInteractionGraph(
  cdp: CDPHandle,
  url: string,
  title: string,
  includeGeometry: boolean,
): Promise<InteractionGraph> {
  const { nodes: axNodes } = await cdp.send<GetFullAXTreeResult>(
    "Accessibility.getFullAXTree",
    { depth: -1 },
  );

  // One DOM snapshot for href + clickability, keyed by backendNodeId.
  const domEnrich = await captureDomEnrichment(cdp);

  // Build parent lookup
  const byId = new Map<string, AXNode>();
  for (const n of axNodes) byId.set(n.nodeId, n);

  // Collect ancestor role chain for a node (up to 5 levels)
  function ancestorRoles(nodeId: string, depth = 5): string[] {
    const node = byId.get(nodeId);
    if (!node?.parentId || depth === 0) return [];
    const parentRole = mapRole(byId.get(node.parentId)?.role?.value as string | undefined);
    const parentRoles = ancestorRoles(node.parentId, depth - 1);
    return parentRole ? [...parentRoles, parentRole] : parentRoles;
  }

  // Derive a label from descendant text for role-less nodes whose own AX name is
  // empty (div-soup: the text lives in child StaticText/InlineTextBox nodes).
  function descendantText(node: AXNode, depth = 3): string {
    if (depth === 0) return "";
    const parts: string[] = [];
    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (!child) continue;
      const cr = child.role?.value;
      if (cr === "StaticText" || cr === "InlineTextBox") {
        const t = child.name?.value;
        if (typeof t === "string" && t.trim()) parts.push(t.trim());
      } else {
        const sub = descendantText(child, depth - 1);
        if (sub) parts.push(sub);
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // True if any descendant maps to a semantic interactive role. Used to drop
  // inferred wrapper nodes whose real interactive child is already captured.
  function hasInteractiveDescendant(node: AXNode, depth = 5): boolean {
    if (depth === 0) return false;
    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (!child) continue;
      const cr = mapRole(child.role?.value as string | undefined);
      if (cr && INTERACTIVE_ROLES.has(cr)) return true;
      if (hasInteractiveDescendant(child, depth - 1)) return true;
    }
    return false;
  }

  // Ordinal tracker: (role, name) → count
  const ordinalTracker = new Map<string, number>();

  const igNodes = new Map<NodeId, IGNode>();
  const nodeOrder: NodeId[] = [];
  const nameToIds = new Map<string, NodeId[]>();

  for (const axNode of axNodes) {
    if (axNode.ignored) continue;

    const rawRole = axNode.role?.value as string | undefined;
    const axName = (axNode.name?.value as string | undefined) ?? "";
    const enrich = axNode.backendDOMNodeId !== undefined ? domEnrich.get(axNode.backendDOMNodeId) : undefined;

    let role = mapRole(rawRole);
    let label = axName;
    if (!role) {
      // No semantic role — but if the DOM says it's actually actionable (Chrome's
      // click heuristic or a tabindex), infer a role so div-soup UIs aren't
      // invisible. Role-less divs often have an empty AX name (their text sits in
      // child StaticText nodes), so derive the label from descendant text.
      const actionable = enrich?.clickable === true || enrich?.focusable === true;
      if (!actionable) continue;
      // A clickable wrapper around a real control is redundant — the child gets
      // captured with its proper role; emitting the wrapper just adds a noisy,
      // verbose-label duplicate.
      if (hasInteractiveDescendant(axNode)) continue;
      if (label === "") label = descendantText(axNode);
      if (label === "" && enrich?.href === undefined) continue; // no usable identity
      role = enrich?.href !== undefined ? "link" : "button";
    }

    // Skip non-interactive + non-landmark nodes at L1
    if (!includeGeometry && !INTERACTIVE_ROLES.has(role) && role !== "heading" && role !== "landmark") {
      continue;
    }

    const props = axNode.properties;

    const ordinalKey = `${role}:${label.toLowerCase().trim()}`;
    const ordinal = (ordinalTracker.get(ordinalKey) ?? 0);
    ordinalTracker.set(ordinalKey, ordinal + 1);

    const explicitId = getStringProp(props, "id");

    const href = enrich?.href;

    const rawId = computeNodeId({
      role,
      axName: label,
      ...(axNode.backendDOMNodeId !== undefined ? { backendDOMNodeId: axNode.backendDOMNodeId } : {}),
      ...(explicitId !== undefined ? { explicitId } : {}),
      ...(href !== undefined ? { href } : {}),
      ancestorRoles: ancestorRoles(axNode.nodeId),
      ordinal,
    });
    const nodeId = rawId as NodeId;

    const geometry = includeGeometry && axNode.backendDOMNodeId
      ? await fetchGeometry(cdp, axNode.backendDOMNodeId)
      : undefined;

    // Build relations
    const relations: NodeRelation[] = [];
    // (Full relation wiring comes in S2 polish — tracked in LabelledBy/Controls props)

    const rawValue = axNode.value?.value as string | undefined;
    const rawLevel = role === "heading" ? getNumberProp(props, "level") : undefined;

    const node: IGNode = {
      id: nodeId,
      role,
      label,
      state: {
        disabled: getBoolProp(props, "disabled"),
        hidden: getBoolProp(props, "hidden"),
        ...(props?.some((p) => p.name === "checked") ? { checked: getBoolProp(props, "checked") } : {}),
        ...(props?.some((p) => p.name === "expanded") ? { expanded: getBoolProp(props, "expanded") } : {}),
        ...(props?.some((p) => p.name === "selected") ? { selected: getBoolProp(props, "selected") } : {}),
        ...(props?.some((p) => p.name === "required") ? { required: getBoolProp(props, "required") } : {}),
        ...(props?.some((p) => p.name === "readonly") ? { readonly: getBoolProp(props, "readonly") } : {}),
      },
      relations,
      ...(axName ? { axName } : {}),
      ...(rawValue !== undefined ? { value: rawValue } : {}),
      ...(rawLevel !== undefined ? { level: rawLevel } : {}),
      ...(href !== undefined ? { href } : {}),
      ...(geometry !== undefined ? { geometry } : {}),
    };

    igNodes.set(nodeId, node);
    nodeOrder.push(nodeId);

    const existing = nameToIds.get(label) ?? [];
    existing.push(nodeId);
    nameToIds.set(label, existing);
  }

  const serialized = JSON.stringify({ url, title, nodes: Array.from(igNodes.values()) });
  return {
    tier: includeGeometry ? "L2" : "L1",
    url,
    title,
    nodes: igNodes,
    nodeOrder,
    serializedSize: Buffer.byteLength(serialized, "utf8"),
  };
}
