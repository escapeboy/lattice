/**
 * One decision cycle: element table -> one Jev request -> a validated,
 * confidence-gated decision. No browser work happens here, so `jevLatencyMs` is
 * a clean HTTP-round-trip number.
 */

import type { ElementTable, Operation, TargetedOperation } from "./element-table.js";
import { TARGETED_OPERATIONS } from "./element-table.js";
import { buildRequest, TARGET_QUESTION_ID, type RecentAction } from "./questions.js";
import { callJev, validateChoice, type ChoiceAnswer } from "./jev-client.js";
import type { InteractionGraph } from "@lattice/perception";

/** Below these, the spike does not act. Set by the brief, not tuned to results. */
export const MIN_OPERATION_CONFIDENCE = 0.6;
export const MIN_TARGET_CONFIDENCE = 0.5;

export type DecisionOutcome =
  | { kind: "act"; operation: TargetedOperation; targetIndex: number }
  | { kind: "control"; operation: Extract<Operation, "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE"> }
  | { kind: "blocked"; reason: BlockedReason };

export type BlockedReason =
  | "model_chose_blocked"
  | "model_chose_other_operation"
  | "model_chose_other_target"
  | "low_operation_confidence"
  | "low_target_confidence"
  | "no_elements"
  | "target_head_missing";

export interface Decision {
  readonly outcome: DecisionOutcome;
  /** Full distributions for every head, logged for every step. */
  readonly operationAnswer: ChoiceAnswer | undefined;
  readonly targetAnswers: Readonly<Record<string, ChoiceAnswer>>;
  readonly jevLatencyMs: number;
  readonly inputTokens: number;
  readonly stateTokensEstimate: number;
  readonly offeredOperations: readonly Operation[];
  readonly elementCount: number;
  readonly trimmedElements: number;
}

export async function decideOnce(args: {
  ig: InteractionGraph;
  table: ElementTable;
  goal: string;
  recentActions: readonly RecentAction[];
  pageText?: string;
}): Promise<Decision> {
  const { table } = args;

  if (table.elements.length === 0) {
    return {
      outcome: { kind: "blocked", reason: "no_elements" },
      operationAnswer: undefined,
      targetAnswers: {},
      jevLatencyMs: 0,
      inputTokens: 0,
      stateTokensEstimate: 0,
      offeredOperations: [],
      elementCount: 0,
      trimmedElements: 0,
    };
  }

  const built = buildRequest(args);
  const { response, latencyMs, inputTokens } = await callJev(built.request);

  const operationOptions = [...built.offeredOperations, "other"];
  const operationAnswer = validateChoice(response.answers["operation"], operationOptions);

  const targetAnswers: Record<string, ChoiceAnswer> = {};
  for (const op of built.offeredTargets) {
    const qid = TARGET_QUESTION_ID[op];
    const raw = response.answers[qid];
    if (raw === undefined) continue;
    const criteria = (built.request.questions[qid] as { criteria: Record<string, string> }).criteria;
    // A malformed head is only fatal when it is the head we intend to execute.
    try {
      targetAnswers[qid] = validateChoice(raw, Object.keys(criteria));
    } catch {
      // leave it out; handled below if this is the chosen head
    }
  }

  const base = {
    operationAnswer,
    targetAnswers,
    jevLatencyMs: latencyMs,
    inputTokens,
    stateTokensEstimate: built.stateTokensEstimate,
    offeredOperations: built.offeredOperations,
    elementCount: table.elements.length,
    trimmedElements: built.trimmedElements,
  };

  const chosen = operationAnswer.choice;

  if (operationAnswer.confidence < MIN_OPERATION_CONFIDENCE) {
    return { ...base, outcome: { kind: "blocked", reason: "low_operation_confidence" } };
  }
  if (chosen === "other") {
    return { ...base, outcome: { kind: "blocked", reason: "model_chose_other_operation" } };
  }
  if (chosen === "BLOCKED") {
    return { ...base, outcome: { kind: "blocked", reason: "model_chose_blocked" } };
  }
  if (chosen === "SCROLL_UP" || chosen === "SCROLL_DOWN" || chosen === "WAIT" || chosen === "DONE") {
    return { ...base, outcome: { kind: "control", operation: chosen } };
  }

  const op = TARGETED_OPERATIONS.find((o) => o === chosen);
  if (!op) return { ...base, outcome: { kind: "blocked", reason: "model_chose_other_operation" } };

  const answer = targetAnswers[TARGET_QUESTION_ID[op]];
  if (!answer) return { ...base, outcome: { kind: "blocked", reason: "target_head_missing" } };
  if (answer.confidence < MIN_TARGET_CONFIDENCE) {
    return { ...base, outcome: { kind: "blocked", reason: "low_target_confidence" } };
  }
  if (answer.choice === "other") {
    return { ...base, outcome: { kind: "blocked", reason: "model_chose_other_target" } };
  }

  return { ...base, outcome: { kind: "act", operation: op, targetIndex: Number(answer.choice) } };
}

/** Confidence blocks are the ones the brief says to retry once after re-perceiving. */
export function isRetryableBlock(reason: BlockedReason): boolean {
  return reason === "low_operation_confidence" || reason === "low_target_confidence";
}
