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
export type { ReAnchor, GovernedActionResult, ActuatorContext, RateLimiterPort, RobotsCheckerPort, ActionDescriber, EffectBackstopPort, BackstopState } from "./governed-actuator.js";
export { runLadder, locateInIG, RecoveryExecutor } from "./recovery.js";
export { normalizeLabel, labelMatches } from "./label-match.js";
export { pointerPointFor } from "./pointer-target.js";
export { probeEffect } from "./effect-probe.js";
export { resolveTarget } from "./resolver.js";
export type { ResolvedTarget } from "./resolver.js";
export { EffectBackstop } from "./effect-backstop.js";
export type { PausedRequest, BackstopOptions, EscalationHandler, BackstopStats } from "./effect-backstop.js";
export { decide as backstopDecide, classifyGraphql, endpointKey, TELEMETRY_HOSTS, TELEMETRY_HOSTS_VERSION } from "./backstop-policy.js";
export type { BackstopRequestFacts, BackstopContext, BackstopDecision, GraphqlVerdict } from "./backstop-policy.js";
export { collectEngineEvidence } from "./engine-evidence.js";
export type { PerceivedNode } from "./engine-evidence.js";
export type { PointerPoint } from "./pointer-target.js";
export type {
  RecoveryRung,
  RecoveryOutcome,
  RecoveryTarget,
  LadderInputs,
  LadderResult,
  LocatableNode,
  RecoveryDeps,
} from "./recovery.js";

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
