/**
 * @lattice/perception — Interaction Graph engine.
 */

export type {
  FidelityTier,
  IGDelta,
  IGNode,
  InteractionGraph,
  L0Summary,
  NodeGeometry,
  NodeId,
  NodeRelation,
  NodeRole,
  PerceptionEngine,
  PerceptionSnapshot,
} from "./types.js";

export { PerceptionEngineImpl } from "./engine.js";
export { computeNodeId } from "./identity.js";
export { snapshotToIG, parseSnapshotTree, igDelta } from "./from-snapshot.js";
export type { SnapshotIG, SnapshotIGOptions, TaintMark } from "./from-snapshot.js";
export { compactNode, compactNodes, compactDelta } from "./compact.js";
export type { CompactNode, CompactDelta } from "./compact.js";
export { PerceptionCache } from "./cache.js";
export type { CacheResolution } from "./cache.js";
export { pageSignals } from "./signals.js";
export type { PageSignals } from "./signals.js";

import type { CDPHandle } from "@lattice/engine";
import { PerceptionEngineImpl } from "./engine.js";
import type { PerceptionEngine } from "./types.js";

export function createPerceptionEngine(cdp: CDPHandle): PerceptionEngine {
  return new PerceptionEngineImpl(cdp);
}
