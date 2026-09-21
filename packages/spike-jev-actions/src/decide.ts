/**
 * One decision cycle: element table -> one Jev request -> a validated,
 * confidence-gated decision. No browser work happens here, so `jevLatencyMs` is
 * a clean HTTP-round-trip number.
 */

import type { ElementTable, Operation, TargetedOperation } from "./element-table.js";
import { TARGETED_OPERATIONS } from "./element-table.js";
import { actionKey, buildRequest, hadNoEffect, TARGET_QUESTION_ID, type RecentAction } from "./questions.js";
import { callJev, validateChoice, type ChoiceAnswer } from "./jev-client.js";
import type { InteractionGraph } from "@lattice/perception";

/**
 * A MARGIN rule, not an absolute threshold.
 *
 * The first iteration used absolute floors (0.6 operation, 0.5 target) and
 * blocked 7 of 10 tasks on them. That measures the wrong thing: a head spread
 * over four plausible options at 0.45 is genuinely undecided, but a head at
 * 0.45 with the runner-up at 0.05 is not — it is confident and merely has a
 * long tail. What matters is whether the top choice STANDS OUT.
 *
 * Act when the top two are separated by `MIN_MARGIN`, or when the top option
 * alone clears `CONFIDENT_ENOUGH`. Both branches are logged so the split can
 * be read off a run rather than assumed.
 */
export const MIN_MARGIN = 0.15;
export const CONFIDENT_ENOUGH = 0.5;

/** Which arm of the margin rule fired, for the run log. */
export type DecisionBranch = "margin" | "absolute" | "undecided";

export interface MarginVerdict {
  readonly act: boolean;
  readonly branch: DecisionBranch;
  readonly p1: number;
  readonly p2: number;
}

/**
 * Apply the margin rule to a distribution, ignoring a set of excluded options.
 * Excluding is how loop detection reaches the decision: a target that has
 * already been tried with no effect is removed from consideration entirely
 * rather than merely discouraged in the prompt.
 */
export function marginVerdict(
  probabilities: Readonly<Record<string, number>>,
  excluded: ReadonlySet<string> = new Set(),
): MarginVerdict {
  const ranked = Object.entries(probabilities)
    .filter(([k]) => !excluded.has(k))
    .sort((a, b) => b[1] - a[1]);
  const p1 = ranked[0]?.[1] ?? 0;
  const p2 = ranked[1]?.[1] ?? 0;
  if (p1 - p2 >= MIN_MARGIN) return { act: true, branch: "margin", p1, p2 };
  if (p1 >= CONFIDENT_ENOUGH) return { act: true, branch: "absolute", p1, p2 };
  return { act: false, branch: "undecided", p1, p2 };
}

/** The top remaining option after exclusions, or undefined if none is left. */
function topChoice(
  probabilities: Readonly<Record<string, number>>,
  excluded: ReadonlySet<string>,
): string | undefined {
  const ranked = Object.entries(probabilities)
    .filter(([k]) => !excluded.has(k))
    .sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0];
}

/**
 * Targets already tried with this operation that produced no observable effect.
 *
 * Twice is the threshold, not once: a single no-op can be a page that had not
 * finished rendering. Twice is a loop.
 */
export function loopedTargets(
  recentActions: readonly RecentAction[],
  operation: Operation,
): ReadonlySet<string> {
  const counts = new Map<string, { n: number; label: string }>();
  for (const a of recentActions) {
    if (a.operation !== operation || !hadNoEffect(a)) continue;
    const key = actionKey(a);
    const prev = counts.get(key);
    counts.set(key, { n: (prev?.n ?? 0) + 1, label: (a.targetLabel ?? "").trim().toLowerCase() });
  }
  const out = new Set<string>();
  for (const { n, label } of counts.values()) if (n >= 2 && label) out.add(label);
  return out;
}

export type DecisionOutcome =
  | { kind: "act"; operation: TargetedOperation; targetIndex: number }
  | { kind: "control"; operation: Extract<Operation, "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE"> }
  | { kind: "blocked"; reason: BlockedReason };

export type BlockedReason =
  | "model_chose_blocked"
  | "model_chose_other_operation"
  | "model_chose_other_target"
  | "operation_undecided"
  | "target_undecided"
  | "no_elements"
  | "all_targets_looped"
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
  /** Which arm of the margin rule fired for each head, for the run log. */
  readonly operationBranch: DecisionBranch | undefined;
  readonly targetBranch: DecisionBranch | undefined;
  /** Element labels excluded by loop detection this step. */
  readonly excludedByLoop: readonly string[];
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
      operationBranch: undefined,
      targetBranch: undefined,
      excludedByLoop: [],
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

  const opVerdict = marginVerdict(operationAnswer.probabilities);
  const base = {
    operationAnswer,
    targetAnswers,
    jevLatencyMs: latencyMs,
    inputTokens,
    stateTokensEstimate: built.stateTokensEstimate,
    offeredOperations: built.offeredOperations,
    elementCount: table.elements.length,
    trimmedElements: built.trimmedElements,
    operationBranch: opVerdict.branch,
    targetBranch: undefined as DecisionBranch | undefined,
    excludedByLoop: [] as string[],
  };

  if (!opVerdict.act) {
    return { ...base, outcome: { kind: "blocked", reason: "operation_undecided" } };
  }

  const chosen = topChoice(operationAnswer.probabilities, new Set()) ?? operationAnswer.choice;

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

  // Loop detection, enforced in CODE rather than asked for in the prompt: a
  // target already tried twice with this operation and no observable effect is
  // removed from the distribution entirely. Telling the model not to repeat
  // itself did not stop it repeating itself.
  const loopedLabels = loopedTargets(args.recentActions, op);
  const excludedIndices = new Set<string>();
  const excludedLabels: string[] = [];
  if (loopedLabels.size > 0) {
    for (const el of table.elements) {
      if (loopedLabels.has(el.label.trim().toLowerCase())) {
        excludedIndices.add(String(el.index));
        excludedLabels.push(el.label);
      }
    }
  }

  const tgtVerdict = marginVerdict(answer.probabilities, excludedIndices);
  const withTarget = { ...base, targetBranch: tgtVerdict.branch, excludedByLoop: excludedLabels };

  const remaining = Object.keys(answer.probabilities).filter(
    (k) => k !== "other" && !excludedIndices.has(k),
  );
  if (remaining.length === 0) {
    return { ...withTarget, outcome: { kind: "blocked", reason: "all_targets_looped" } };
  }
  if (!tgtVerdict.act) {
    return { ...withTarget, outcome: { kind: "blocked", reason: "target_undecided" } };
  }

  const pick = topChoice(answer.probabilities, excludedIndices);
  if (pick === undefined || pick === "other") {
    return { ...withTarget, outcome: { kind: "blocked", reason: "model_chose_other_target" } };
  }

  return { ...withTarget, outcome: { kind: "act", operation: op, targetIndex: Number(pick) } };
}

/** An undecided head is worth one re-perceive; a looped-out target is not. */
export function isRetryableBlock(reason: BlockedReason): boolean {
  return reason === "operation_undecided" || reason === "target_undecided";
}
