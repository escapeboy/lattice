/**
 * @lattice/runtime — Concurrency runtime + scheduler.
 */

export type {
  BrowserContextId,
  ContextHandle,
  ContextSlot,
  FanOutResult,
  ResourceBudget,
  RuntimeScheduler,
  SessionTopology,
  SnapshotData,
} from "./types.js";

export { RuntimeSchedulerImpl } from "./scheduler.js";

import type { EngineAdapter } from "@lattice/engine";
import { RuntimeSchedulerImpl } from "./scheduler.js";
import type { ResourceBudget, RuntimeScheduler } from "./types.js";

export function createRuntimeScheduler(
  engine: EngineAdapter,
  budget: ResourceBudget,
): RuntimeScheduler {
  return new RuntimeSchedulerImpl(engine, budget);
}
