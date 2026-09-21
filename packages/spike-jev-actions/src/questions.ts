/**
 * Builds the single Jev request for one decision cycle.
 *
 * One request carries parallel questions: the operation head, plus a target head
 * per targeted operation that currently has at least one valid element. Only the
 * head matching the chosen operation is ever executed; the others are
 * speculative and discarded, which is what buys one round trip per step.
 *
 * Every string below is either a static template, the operator goal, an element
 * index, or a role. See taint.ts.
 */

import type { ElementTable, Operation, TargetedOperation } from "./element-table.js";
import { stateRows } from "./element-table.js";
import { assertTargetCriteriaShape, assertUntainted, collectPageStrings } from "./taint.js";
import type { InteractionGraph } from "@lattice/perception";

export const JEV_MODEL = "jev-1.13.0";

/** Jev: 32k tokens for state plus the longest question. Stay well inside it. */
const STATE_TOKEN_BUDGET = 24_000;
const CHARS_PER_TOKEN = 4;
const MAX_LABEL_CHARS = 160;
/** Visible page text is the largest thing in state; keep it well inside budget. */
const MAX_PAGE_TEXT_CHARS = 12_000;

/**
 * Static operation rubric. Each entry describes what the operation DOES, in our
 * words. No option is phrased as a negation and none references page content.
 */
const OPERATION_CRITERIA: Record<Operation, string> = {
  CLICK: "Activate one of the listed controls.",
  TYPE_TEXT: "Enter a value into one of the listed editable fields.",
  SELECT: "Choose an option in one of the listed dropdowns.",
  SCROLL_UP: "Move the viewport toward the start of the page to reveal earlier content.",
  SCROLL_DOWN: "Move the viewport toward the end of the page to reveal later content.",
  WAIT: "Pause for the page to finish updating before deciding again.",
  DONE: "The goal is already satisfied by what is currently visible.",
  BLOCKED: "Progress toward the goal requires something outside the listed controls.",
};

/** Always available: they need no target and are always a legitimate answer. */
const ALWAYS_OFFERED: readonly Operation[] = ["WAIT", "DONE", "BLOCKED"];

const OPERATION_RULES = [
  "Pick the single operation that best advances the stated goal from the current page.",
  "`state.elements` lists every control available right now, each with an index.",
  "Judge only the current page. `state.recent_actions` lists what was already done.",
  "A recent action whose effect is `nothing_happened` did not work; do not repeat it.",
];

const TARGET_RULES = [
  "Pick the one element index this operation should act on.",
  "Each option key is an element index in `state.elements`; its value is that element's role.",
  "Read the element's label and value from `state.elements` under the same index.",
];

const OTHER_OPERATION = "None of the listed operations fits the goal on this page.";
const OTHER_TARGET = "No listed element is the right target for this operation.";

const TARGET_QUESTION_ID: Record<TargetedOperation, string> = {
  CLICK: "click_target",
  TYPE_TEXT: "type_text_target",
  SELECT: "select_target",
};

/**
 * One past step, with what actually happened afterwards.
 *
 * The first iteration recorded only `pageChanged: false`, hard-coded — so the
 * model was told nothing useful and had no way to notice it was repeating
 * itself. On wikipedia-detail it clicked the same anchor ten times at 0.93
 * confidence. Recording the OBSERVED EFFECT is what makes that legible, to the
 * model and to the loop detector in `decide.ts`.
 */
export interface RecentAction {
  readonly operation: Operation;
  readonly targetIndex?: number;
  /** Role of the control acted on, so a repeat is recognisable after re-indexing. */
  readonly targetRole?: string;
  /** PAGE-DERIVED. Goes in state, never in a question. */
  readonly targetLabel?: string;
  /** Did the URL change? */
  readonly urlChanged: boolean;
  /** Did the scroll position change? */
  readonly scrollChanged: boolean;
  /** Did the interaction graph change (nodes added/removed/relabelled)? */
  readonly domChanged: boolean;
}

/** True when a step produced no observable effect at all. */
export function hadNoEffect(a: RecentAction): boolean {
  return !a.urlChanged && !a.scrollChanged && !a.domChanged;
}

/** Identity of a step for loop detection: the operation and what it touched. */
export function actionKey(a: Pick<RecentAction, "operation" | "targetRole" | "targetLabel">): string {
  return `${a.operation}|${a.targetRole ?? ""}|${(a.targetLabel ?? "").trim().toLowerCase()}`;
}

export interface JevRequest {
  readonly model: string;
  readonly state: Record<string, unknown>;
  readonly questions: Record<string, unknown>;
}

export interface BuiltRequest {
  readonly request: JevRequest;
  /** Which target heads were actually offered, so the caller knows what to read. */
  readonly offeredTargets: readonly TargetedOperation[];
  readonly offeredOperations: readonly Operation[];
  readonly stateTokensEstimate: number;
  readonly trimmedElements: number;
}

function trimLabel(s: string): string {
  return s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS)}…` : s;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * Build the request. Throws TaintViolation rather than sending a request whose
 * questions carry page text — a spike that leaks here would measure the wrong
 * system, so failing loudly is the point.
 */
/**
 * Every string this module can put into a question. Used by the taint guard to
 * tell "our constant" from "a page string that happens to look like it".
 */
const STATIC_TEMPLATES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(OPERATION_CRITERIA),
  ...Object.values(OPERATION_CRITERIA),
  ...OPERATION_RULES,
  ...TARGET_RULES,
  OTHER_OPERATION,
  OTHER_TARGET,
  "choice",
  "type",
  "goal",
  "operation",
  "rules",
  "criteria",
  "instructions",
  "other",
  ...Object.values(TARGET_QUESTION_ID),
]);

export function buildRequest(args: {
  ig: InteractionGraph;
  table: ElementTable;
  goal: string;
  recentActions: readonly RecentAction[];
  /**
   * Visible page text. Optional on purpose: an element table alone carries no
   * non-interactive prose, so a page's visible instructions never reach the
   * model unless this is supplied. Both configurations are measured.
   */
  pageText?: string;
}): BuiltRequest {
  const { ig, table, goal, recentActions, pageText } = args;

  // `label`/`value` are strings by construction in stateRows; the Record type
  // erases that, so narrow rather than String()-coercing an unknown.
  const asText = (v: unknown): string => (typeof v === "string" ? v : "");
  let rows: Array<Record<string, unknown>> = stateRows(table).map((r) => ({
    ...r,
    label: trimLabel(asText(r["label"])),
    ...(r["value"] !== undefined ? { value: trimLabel(asText(r["value"])) } : {}),
  }));
  let trimmed = 0;

  const buildState = (elementRows: Array<Record<string, unknown>>): Record<string, unknown> => ({
    page: {
      url: ig.url,
      title: ig.title,
      ...(pageText !== undefined ? { text: pageText.slice(0, MAX_PAGE_TEXT_CHARS) } : {}),
    },
    elements: elementRows,
    // Last 8 steps with their observed effect. Page-derived labels belong in
    // state, never in a question — see taint.ts.
    recent_actions: recentActions.slice(-8).map((a) => ({
      operation: a.operation,
      ...(a.targetIndex !== undefined ? { target_index: a.targetIndex } : {}),
      ...(a.targetRole !== undefined ? { target_role: a.targetRole } : {}),
      ...(a.targetLabel !== undefined ? { target_label: trimLabel(a.targetLabel) } : {}),
      effect: {
        url_changed: a.urlChanged,
        scroll_changed: a.scrollChanged,
        dom_changed: a.domChanged,
        nothing_happened: !a.urlChanged && !a.scrollChanged && !a.domChanged,
      },
    })),
  });

  // Trim from the far end of the table (furthest from the viewport) until the
  // state fits. Never rely on the API truncating it for us.
  let state = buildState(rows);
  while (estimateTokens(state) > STATE_TOKEN_BUDGET && rows.length > 1) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length * 0.8)));
    trimmed = table.elements.length - rows.length;
    state = buildState(rows);
  }

  const survivingIndices = new Set(rows.map((r) => Number(r["index"])));
  const elements = table.elements.filter((e) => survivingIndices.has(e.index));

  const offeredTargets = table.availableTargeted.filter((op) =>
    elements.some((e) => e.operations.includes(op)),
  );
  const scrolls: Operation[] = [
    ...(table.canScrollUp ? (["SCROLL_UP"] as const) : []),
    ...(table.canScrollDown ? (["SCROLL_DOWN"] as const) : []),
  ];
  const offeredOperations: Operation[] = [...offeredTargets, ...scrolls, ...ALWAYS_OFFERED];

  const operationCriteria: Record<string, string> = { other: OTHER_OPERATION };
  for (const op of offeredOperations) operationCriteria[op] = OPERATION_CRITERIA[op];

  const questions: Record<string, unknown> = {
    operation: {
      type: "choice",
      instructions: { goal, rules: OPERATION_RULES },
      criteria: operationCriteria,
    },
  };

  for (const op of offeredTargets) {
    const criteria: Record<string, string> = { other: OTHER_TARGET };
    for (const e of elements) {
      if (e.operations.includes(op)) criteria[String(e.index)] = e.role;
    }
    assertTargetCriteriaShape(criteria);
    questions[TARGET_QUESTION_ID[op]] = {
      type: "choice",
      instructions: { goal, operation: op, rules: TARGET_RULES },
      criteria,
    };
  }

  // The guard runs on the questions only — state is exactly where page text belongs.
  assertUntainted(questions, collectPageStrings(ig), [goal], STATIC_TEMPLATES);

  return {
    request: { model: JEV_MODEL, state, questions },
    offeredTargets,
    offeredOperations,
    stateTokensEstimate: estimateTokens(state),
    trimmedElements: trimmed,
  };
}

export { TARGET_QUESTION_ID, OPERATION_CRITERIA };
