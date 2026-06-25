/**
 * @lattice/action — Semantic action engine.
 */

export type {
  ActionCommand,
  ActionErrorCode,
  ActionResult,
  ActionTarget,
  ActionType,
  WaitCondition,
} from "./types.js";

export { ActionError } from "./types.js";
export { ActionExecutor } from "./executor.js";

import type { CDPHandle, ContextHandle } from "@lattice/engine";
import type { PerceptionEngine } from "@lattice/perception";
import { ActionExecutor } from "./executor.js";
import type { ActionEngine } from "./types.js";

export function createActionEngine(
  cdp: CDPHandle,
  ctx: ContextHandle,
  perception: PerceptionEngine,
): ActionEngine {
  return new ActionExecutor(cdp, ctx, perception);
}
