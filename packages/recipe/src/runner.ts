/**
 * Recipe runner — applies a declarative recipe against the LIVE page (P3.1).
 *
 * The whole safety argument lives here. Applying a step is always:
 *   1. perceive the current IG (tainting holds — the recipe does NOT skip perception);
 *   2. resolve the step's semantic locator (role+label) against the LIVE nodes to a
 *      NodeId — fresh every run, so a re-rendered/changed page is handled, not a
 *      baked-in stale ref;
 *   3. build a SEMANTIC ActionCommand and hand it to the governed gate — the same
 *      kernel classification + grant path as the semantic agent.
 *
 * Consequences of (3): a recipe can never bypass gating. A `submit` step is
 * classified consequential and refused without a human grant exactly as if the
 * agent had typed it. There is no toCommand output that is a raw ref, a selector,
 * a URL-by-content, or a script — the recipe is data, never executable code.
 *
 * If a locator no longer resolves (the site changed under the recipe), the runner
 * does NOT fire a guess or a stale ref — it reports a mismatch and defers to the
 * semantic fallback, so a drifted recipe degrades gracefully instead of breaking.
 */

import type { NodeId } from "@lattice/perception";
import type { ActionCommand } from "@lattice/action";
import type { Recipe, RecipeStep, SemanticLocator } from "./types.js";

/** A live IG node the runner can resolve a locator against (id + role + label). */
export interface LocatableNode {
  readonly id: NodeId;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
}

/** The governed execution boundary — `GovernedActuator` satisfies this. */
export interface RecipeGate {
  /** Execute one resolved command through the kernel-gated path. May throw on refusal. */
  execute(command: ActionCommand): Promise<{ ok: boolean; url?: string | undefined; extracted?: string }>;
}

export type StepStatus =
  /** Locator resolved (or none needed) and the gate executed it. */
  | "executed"
  /** Locator did not resolve; the semantic fallback handled the step. */
  | "fellBack"
  /** Locator did not resolve and no fallback recovered it. */
  | "unresolved"
  /** The gate refused the command (consequential without grant / prohibited). */
  | "denied";

export interface StepOutcome {
  readonly index: number;
  readonly action: RecipeStep["action"];
  readonly status: StepStatus;
  readonly reason?: string;
}

export interface RecipeRunResult {
  readonly origin: string;
  readonly id: string;
  readonly version: number;
  readonly outcomes: ReadonlyArray<StepOutcome>;
  /** Every step either executed or fell back gracefully (none unresolved/denied-fatal). */
  readonly completed: boolean;
}

export interface RecipeRunDeps {
  /** Perceive the current page's locatable nodes. Called BEFORE each step. */
  readonly perceive: () => ReadonlyArray<LocatableNode>;
  /** The governed gate every command flows through. */
  readonly gate: RecipeGate;
  /** Semantic fallback for a step whose locator no longer matches the live page. */
  readonly fallback?: (step: RecipeStep, nodes: ReadonlyArray<LocatableNode>) => Promise<{ ok: boolean; reason?: string }>;
}

/** Actions that address an element and therefore require a resolved locator. */
const ELEMENT_ACTIONS: ReadonlySet<RecipeStep["action"]> = new Set([
  "act",
  "fill",
  "select",
  "set",
  "submit",
  "scroll_to",
]);

/**
 * Resolve a semantic locator against the live nodes. Matches on the accessible
 * label (the stable semantic anchor); if several nodes share a label, the role
 * disambiguates. No fuzzy/nearest guess — a genuine mismatch returns undefined so
 * the caller takes the documented fallback rather than acting on the wrong element.
 */
export function resolveLocator(loc: SemanticLocator, nodes: ReadonlyArray<LocatableNode>): NodeId | undefined {
  const byLabel = nodes.filter((n) => n.label === loc.label);
  if (byLabel.length === 0) return undefined;
  if (byLabel.length === 1) return byLabel[0]!.id;
  return byLabel.find((n) => n.role === loc.role)?.id;
}

/** Build a semantic ActionCommand from a recipe step. Never yields a raw ref / script. */
export function toCommand(step: RecipeStep, nodeId: NodeId | undefined): ActionCommand {
  switch (step.action) {
    case "navigate":
      return { type: "navigate", url: step.url ?? "" };
    case "extract":
      return { type: "extract", query: step.query ?? "" };
    case "wait_for":
      return { type: "wait_for", condition: { kind: "mutation_quiescence" } };
    case "act":
      return { type: "act", target: { nodeId: nodeId! } };
    case "fill":
      return { type: "fill", target: { nodeId: nodeId! }, value: step.value ?? "" };
    case "select":
      return { type: "select", target: { nodeId: nodeId! }, value: step.value ?? "" };
    case "set":
      return { type: "set", target: { nodeId: nodeId! }, value: step.value ?? "" };
    case "submit":
      return { type: "submit", target: { nodeId: nodeId! } };
    case "scroll_to":
      return { type: "scroll_to", target: { nodeId: nodeId! } };
  }
}

export async function applyRecipe(recipe: Recipe, deps: RecipeRunDeps): Promise<RecipeRunResult> {
  const outcomes: StepOutcome[] = [];

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]!;
    const nodes = deps.perceive();

    let nodeId: NodeId | undefined;
    if (ELEMENT_ACTIONS.has(step.action)) {
      if (!step.locator) {
        outcomes.push({ index: i, action: step.action, status: "unresolved", reason: "element step missing locator" });
        continue;
      }
      nodeId = resolveLocator(step.locator, nodes);
      if (nodeId === undefined) {
        // The site changed under the recipe. Do NOT fire a stale ref — fall back.
        if (deps.fallback) {
          const fb = await deps.fallback(step, nodes);
          outcomes.push({
            index: i,
            action: step.action,
            status: fb.ok ? "fellBack" : "unresolved",
            ...(fb.reason !== undefined ? { reason: fb.reason } : {}),
          });
        } else {
          outcomes.push({ index: i, action: step.action, status: "unresolved", reason: "locator did not match live IG" });
        }
        continue;
      }
    }

    try {
      const r = await deps.gate.execute(toCommand(step, nodeId));
      outcomes.push({
        index: i,
        action: step.action,
        status: r.ok ? "executed" : "denied",
      });
    } catch (e) {
      // The gate refused (e.g. consequential without a grant) — surface, don't swallow.
      outcomes.push({ index: i, action: step.action, status: "denied", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    origin: recipe.origin,
    id: recipe.id,
    version: recipe.version,
    outcomes,
    completed: outcomes.every((o) => o.status === "executed" || o.status === "fellBack"),
  };
}
