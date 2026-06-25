/**
 * Resolves an ActionTarget (NodeId) to a CDP backendDOMNodeId for input dispatch.
 *
 * The NodeId encodes the backendDOMNodeId in its hash prefix when the node was
 * created with a real CDP backendDOMNodeId. We extract it here by querying the
 * current AX tree and re-matching by nodeId string.
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

interface GetBoxModelResult {
  model: { content: number[] };
}

interface PushNodesResult {
  nodeIds: number[];
}

export interface ResolvedTarget {
  backendDOMNodeId: number;
  /** Center point for Input dispatch */
  x: number;
  y: number;
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
      const role = rawRole;

      // Get center point via DOM.getBoxModel
      try {
        const { model } = await cdp.send<GetBoxModelResult>("DOM.getBoxModel", {
          backendNodeId: axNode.backendDOMNodeId,
        });
        const c = model.content;
        const x = ((c[0] ?? 0) + (c[2] ?? 0)) / 2;
        const y = ((c[1] ?? 0) + (c[5] ?? 0)) / 2;
        return { backendDOMNodeId: axNode.backendDOMNodeId, x, y, role, disabled };
      } catch {
        throw new ActionError(
          "obscured",
          "element has no layout box",
          `Cannot get bounding box for node ${nodeId}`,
        );
      }
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
