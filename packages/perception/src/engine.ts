/**
 * PerceptionEngineImpl — builds snapshots and computes deltas.
 */

import type { CDPHandle } from "@lattice/engine";
import { buildInteractionGraph } from "./ax-tree.js";
import type {
  FidelityTier,
  IGDelta,
  IGNode,
  InteractionGraph,
  L0Summary,
  NodeId,
  PerceptionEngine,
  PerceptionSnapshot,
} from "./types.js";

interface GetTargetInfoResult {
  targetInfo: { url: string; title?: string };
}

interface EvaluateResult {
  result: { value: string };
}

async function getPageMeta(cdp: CDPHandle): Promise<{ url: string; title: string }> {
  try {
    const target = await cdp.send<GetTargetInfoResult>("Target.getTargetInfo", {});
    const url = target.targetInfo.url;
    const titleResult = await cdp.send<EvaluateResult>("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    }).catch(() => ({ result: { value: "" } }));
    return { url, title: titleResult.result.value };
  } catch {
    return { url: "", title: "" };
  }
}

export class PerceptionEngineImpl implements PerceptionEngine {
  constructor(private readonly cdp: CDPHandle) {}

  async snapshot(tier: FidelityTier): Promise<PerceptionSnapshot> {
    const { url, title } = await getPageMeta(this.cdp);

    if (tier === "L0") {
      const ig = await buildInteractionGraph(this.cdp, url, title, false);
      const summary: L0Summary = {
        tier: "L0",
        url,
        title,
        interactiveCount: Array.from(ig.nodes.values()).filter(
          (n) =>
            n.role === "button" ||
            n.role === "link" ||
            n.role === "input" ||
            n.role === "select" ||
            n.role === "textarea" ||
            n.role === "checkbox" ||
            n.role === "radio" ||
            n.role === "combobox",
        ).length,
        landmarkCount: Array.from(ig.nodes.values()).filter((n) => n.role === "landmark").length,
      };
      return summary;
    }

    if (tier === "L3") {
      // L3 = pixel render (not in P0 scope); return L2 with geometry as approximation
      return buildInteractionGraph(this.cdp, url, title, true);
    }

    // L1 (default) and L2
    return buildInteractionGraph(this.cdp, url, title, tier === "L2");
  }

  delta(prev: InteractionGraph, next: InteractionGraph): IGDelta {
    const added: IGNode[] = [];
    const removed: NodeId[] = [];
    const updated: IGNode[] = [];

    for (const [id, nextNode] of next.nodes) {
      const prevNode = prev.nodes.get(id);
      if (!prevNode) {
        added.push(nextNode);
      } else if (JSON.stringify(prevNode) !== JSON.stringify(nextNode)) {
        updated.push(nextNode);
      }
    }

    for (const id of prev.nodes.keys()) {
      if (!next.nodes.has(id)) removed.push(id);
    }

    return { added, removed, updated };
  }
}
