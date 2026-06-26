/**
 * @lattice/action — Semantic action engine.
 */

export type {
  ActionCommand,
  ActionEngine,
  ActionErrorCode,
  ActionResult,
  ActionTarget,
  ActionType,
  WaitCondition,
} from "./types.js";

export { ActionError } from "./types.js";
export { ActionExecutor } from "./executor.js";
export { GovernedActuator } from "./governed-actuator.js";
export type { ReAnchor, GovernedActionResult, ActuatorContext, RateLimiterPort } from "./governed-actuator.js";

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
