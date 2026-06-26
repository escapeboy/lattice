/**
 * @lattice/recipe — the capability/recipe library (P3.1).
 *
 * Per-domain DECLARATIVE flows the agent applies instead of rediscovering a known
 * site flow semantically every time. A recipe is data (ordered semantic-locator
 * steps), never code: it shortcuts perception/planning, not gating — every step
 * resolves against the live IG and runs through the same governed actuator.
 */

export type { Recipe, RecipeDef, RecipeStep, RecipeAction, SemanticLocator, RecipeTrust } from "./types.js";
export { RecipeLibrary } from "./library.js";
export { applyRecipe, resolveLocator, toCommand } from "./runner.js";
export type {
  LocatableNode,
  RecipeGate,
  RecipeRunDeps,
  RecipeRunResult,
  StepOutcome,
  StepStatus,
} from "./runner.js";
