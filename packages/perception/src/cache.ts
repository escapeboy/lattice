/**
 * Per-origin perception cache (P2.2).
 *
 * The capability registry caches ACTIONS but not perception, so a repeated flow
 * recomputes and re-sends the full IG every visit. This caches the IG skeleton
 * per origin: on a REVISIT, only nodes that are new or changed vs what the origin
 * already sent are returned — identical state ⇒ nothing to send.
 *
 * HONEST FRAMING: this AMORTIZES the stable-NodeId token cost across REPEAT
 * visits; it does NOT reduce the COLD (first-visit) cost — the full IG, NodeIds
 * and all, is still paid the first time. Cold and warm are reported separately so
 * amortization is never mistaken for fixing the base cost.
 *
 * TAINTING: the cache stores page-origin IGNodes and returns them unchanged. It
 * is a store, not a trust boundary — the gateway re-asserts taint on delivery, so
 * a cache hit is delivered through the same quarantined channel as a fresh
 * perception. The cache is NOT a route around tainting.
 */

import type { IGNode, InteractionGraph, NodeId } from "./types.js";

/** A stable, content-sensitive signature of a node — changes iff the node changed. */
function nodeSignature(n: IGNode): string {
  return JSON.stringify([n.role, n.label, n.value ?? null, n.href ?? null, n.state]);
}

export interface CacheResolution {
  /** Was this origin already cached (a revisit)? */
  readonly warm: boolean;
  /** Nodes that must be sent: new ids, or ids whose content changed. */
  readonly sentNodes: ReadonlyArray<IGNode>;
  /** Node ids present last time but gone now (the agent should drop them). */
  readonly removedIds: ReadonlyArray<NodeId>;
}

interface OriginCache {
  /**
   * The UNION of every (NodeId → signature) the origin has ever delivered. The
   * agent keeps a client-side cache of these, so a node already in the union is
   * not re-sent even if it left the page and came back — that is what amortizes
   * the cost across a repeated flow, not just the previous step.
   */
  readonly union: Map<NodeId, string>;
  /** Ids present in the LAST view, to report what has since been removed. */
  lastView: Set<NodeId>;
}

export class PerceptionCache {
  private readonly byOrigin = new Map<string, OriginCache>();

  /** Whether an origin currently has a cached skeleton. */
  has(origin: string): boolean {
    return this.byOrigin.has(origin);
  }

  /**
   * Resolve a fresh perception against the per-origin cache, returning only what
   * must be sent, and updating the cache. A first visit is "cold" (every node is
   * sent); a revisit is "warm" — a node is re-sent only if its (id, signature)
   * was NEVER delivered for this origin (new id, or changed content).
   */
  resolve(origin: string, ig: InteractionGraph): CacheResolution {
    const prev = this.byOrigin.get(origin);
    const warm = prev !== undefined;
    const union = prev?.union ?? new Map<NodeId, string>();
    const sentNodes: IGNode[] = [];
    const currentIds = new Set<NodeId>();

    for (const node of ig.nodes.values()) {
      const sig = nodeSignature(node);
      currentIds.add(node.id);
      if (union.get(node.id) !== sig) {
        sentNodes.push(node); // never delivered, or content changed → send + remember
        union.set(node.id, sig);
      }
    }

    const removedIds: NodeId[] = prev ? [...prev.lastView].filter((id) => !currentIds.has(id)) : [];
    this.byOrigin.set(origin, { union, lastView: currentIds });
    return { warm, sentNodes, removedIds };
  }

  /** Drop an origin's cached skeleton (e.g. on a hard reload / logout). */
  invalidate(origin: string): void {
    this.byOrigin.delete(origin);
  }
}
