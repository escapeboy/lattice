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

import type { CDPHandle } from "@lattice/engine";
import { PerceptionEngineImpl } from "./engine.js";
import type { PerceptionEngine } from "./types.js";

export function createPerceptionEngine(cdp: CDPHandle): PerceptionEngine {
  return new PerceptionEngineImpl(cdp);
}
