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

interface GetDocumentResult {
  root: { nodeId: number };
}

interface GetAttributesResult {
  attributes: string[];
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

async function fetchHref(cdp: CDPHandle, backendNodeId: number): Promise<string | undefined> {
  try {
    const { root } = await cdp.send<GetDocumentResult>("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send<{ nodeId: number }>("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [backendNodeId],
    }).catch(() => ({ nodeId: 0 }));
    if (!nodeId) return undefined;
    const { attributes } = await cdp.send<GetAttributesResult>("DOM.getAttributes", { nodeId });
    const hrefIdx = attributes.indexOf("href");
    if (hrefIdx === -1) return undefined;
    void root; // used implicitly via DOM session
    return attributes[hrefIdx + 1];
  } catch {
    return undefined;
  }
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

  // Ordinal tracker: (role, name) → count
  const ordinalTracker = new Map<string, number>();

  const igNodes = new Map<NodeId, IGNode>();
  const nodeOrder: NodeId[] = [];
  const nameToIds = new Map<string, NodeId[]>();

  for (const axNode of axNodes) {
    if (axNode.ignored) continue;

    const rawRole = axNode.role?.value as string | undefined;
    const role = mapRole(rawRole);
    if (!role) continue;

    // Skip non-interactive + non-landmark nodes at L1
    if (!includeGeometry && !INTERACTIVE_ROLES.has(role) && role !== "heading" && role !== "landmark") {
      continue;
    }

    const axName = (axNode.name?.value as string | undefined) ?? "";
    const props = axNode.properties;

    const ordinalKey = `${role}:${axName.toLowerCase().trim()}`;
    const ordinal = (ordinalTracker.get(ordinalKey) ?? 0);
    ordinalTracker.set(ordinalKey, ordinal + 1);

    const explicitId = getStringProp(props, "id");

    const href = role === "link" && axNode.backendDOMNodeId
      ? await fetchHref(cdp, axNode.backendDOMNodeId)
      : undefined;

    const rawId = computeNodeId({
      role,
      axName,
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
    const rawLevel = role === "heading" ? Number(getStringProp(props, "level") ?? "0") || undefined : undefined;

    const node: IGNode = {
      id: nodeId,
      role,
      label: axName,
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

    const existing = nameToIds.get(axName) ?? [];
    existing.push(nodeId);
    nameToIds.set(axName, existing);
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
