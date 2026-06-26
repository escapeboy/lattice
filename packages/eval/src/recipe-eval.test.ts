/**
 * Recipe eval gate (P3.1) — asserts a recipe shows a MEASURABLE improvement over
 * the semantic fallback (else it isn't done), and that drift degrades gracefully.
 */

import { describe, it, expect } from "vitest";
import { runRecipeEval, formatRecipeReport } from "./recipe-eval.js";

describe("recipe eval — known flow with a recipe vs semantic fallback", () => {
  it("a recipe measurably cuts planning tokens (the headline before/after)", async () => {
    const r = await runRecipeEval();
    expect(r.recipePlanningTokens).toBeLessThan(r.semanticPlanningTokens);
    expect(r.planningRatio).toBeLessThan(1);
  });

  it("a recipe collapses per-step model round-trips to one up-front selection", async () => {
    const r = await runRecipeEval();
    expect(r.semanticModelCalls).toBe(r.steps);
    expect(r.recipeModelCalls).toBe(1);
    expect(r.recipeModelCalls).toBeLessThan(r.semanticModelCalls);
  });

  it("under drift, the Lattice recipe completes where a naive baked-locator one breaks", async () => {
    const r = await runRecipeEval();
    expect(r.driftSuccessNaive).toBeLessThan(1); // naive breaks on the changed step
    expect(r.driftSuccessLattice).toBe(1); // resolve-live + fallback completes
    expect(r.driftSuccessLattice).toBeGreaterThan(r.driftSuccessNaive);
  });

  it("renders a before/after report with the three metrics", async () => {
    const text = formatRecipeReport(await runRecipeEval());
    expect(text).toContain("planning tokens");
    expect(text).toContain("model round-trips");
    expect(text).toContain("drifted site");
    expect(text).toContain("amortizes PLANNING");
  });
});
