/**
 * Resolves an ActionTarget (NodeId) to a CDP backendDOMNodeId for input dispatch.
 *
 * The NodeId encodes the backendDOMNodeId in its hash prefix when the node was
 * created with a real CDP backendDOMNodeId. We extract it here by querying the
 * current AX tree and re-matching by nodeId string.
 *
 * Identity only. The click point is NOT computed here: a coordinate taken at
 * resolve time can be stale or off-screen by the time the event is dispatched,
 * which is exactly the failure this package had. Geometry comes from
 * `pointerPointFor` immediately before dispatch.
 */

import type { CDPHandle } from "@lattice/engine";
import type { NodeId } from "@lattice/perception";
import { ActionError } from "./types.js";

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { type: string; value?: string };
  properties?: Array<{ name: string; value: { type: string; value?: unknown } }>;
}

interface GetFullAXTreeResult {
  nodes: AXNode[];
}

interface PushNodesResult {
  nodeIds: number[];
}

export interface ResolvedTarget {
  backendDOMNodeId: number;
  role: string;
  disabled: boolean;
}

/**
 * Maps a stable NodeId back to the live DOM node by matching the encoded
 * backendDOMNodeId fingerprint or by re-running identity hashing.
 */
export async function resolveTarget(
  cdp: CDPHandle,
  nodeId: NodeId,
): Promise<ResolvedTarget> {
  // The NodeId format is "role-<sha256_12hex>". The hash was computed from
  // `bdn:<backendDOMNodeId>` when backendDOMNodeId was available.
  // Re-fetch the AX tree and find the node whose computed identity matches.

  const { nodes } = await cdp.send<GetFullAXTreeResult>("Accessibility.getFullAXTree", {
    depth: -1,
  });

  // Import the identity function dynamically to avoid circular deps
  const { computeNodeId } = await import("@lattice/perception");

  // Build a quick lookup: backendDOMNodeId → AXNode
  for (const axNode of nodes) {
    if (axNode.ignored || axNode.backendDOMNodeId === undefined) continue;

    const rawRole = axNode.role?.value;
    if (!rawRole) continue;

    // We use the same identity logic as perception engine
    const candidateId = computeNodeId({
      role: "button", // will be overridden by role-prefixed hash comparison
      axName: "",
      backendDOMNodeId: axNode.backendDOMNodeId,
      ancestorRoles: [],
      ordinal: 0,
    });

    // The ID prefix (role part) will differ but the hash part (bdn:...) will match
    // regardless of role since backendDOMNodeId is the fingerprint.
    // Extract the hash portion from both IDs and compare.
    const candidateHash = candidateId.split("-").slice(1).join("-");
    const targetHash = (nodeId as string).split("-").slice(1).join("-");

    if (candidateHash === targetHash) {
      const disabled = axNode.properties?.some(
        (p) => p.name === "disabled" && p.value.value === true,
      ) ?? false;
      return { backendDOMNodeId: axNode.backendDOMNodeId, role: rawRole, disabled };
    }
  }

  throw new ActionError(
    "element_not_found",
    "re-perceive the page to get fresh node IDs",
    `Node ${nodeId} not found in current AX tree`,
  );
}

/** Pushes a backendDOMNodeId into the CDP session and returns a runtime nodeId. */
export async function pushBackendNode(cdp: CDPHandle, backendNodeId: number): Promise<number> {
  const { nodeIds } = await cdp.send<PushNodesResult>("DOM.pushNodesByBackendIdsToFrontend", {
    backendNodeIds: [backendNodeId],
  });
  const nodeId = nodeIds[0];
  if (nodeId === undefined) throw new ActionError("element_gone", undefined, "pushNodesByBackendIds failed");
  return nodeId;
}
