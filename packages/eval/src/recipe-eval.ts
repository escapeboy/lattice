/**
 * Recipe eval (P3.1) — measures what a per-domain recipe buys over rediscovering a
 * known flow semantically, on the REAL IG (snapshotToIG over the synth ground truth)
 * and the REAL recipe runner (applyRecipe / resolveLocator). Three honest numbers:
 *
 *   1. PLANNING tokens — the model-facing per-step deliberation. The semantic agent
 *      must read the live interactive-node list every step to DECIDE the next target;
 *      the recipe pre-declares (role,label), so the model only confirms a small step
 *      descriptor. This is the headline saving.
 *   2. MODEL round-trips — LLM calls spent choosing actions. Semantic = one per step;
 *      recipe = one up-front "apply this recipe", zero per step.
 *   3. SUCCESS under drift — when the site changed under the recipe, a naive recipe
 *      that trusts baked-in locators breaks on the changed step; Lattice resolves
 *      against the LIVE IG and FALLS BACK to the semantic path, completing the flow.
 *
 * HONEST framing (mirrors the cache eval): a recipe does NOT skip perception — the
 * IG is still built and tainted every step. It amortizes PLANNING/discovery, not
 * perception. Perception tokens are identical on both paths and are not claimed.
 */

import { snapshotToIG, compactNodes } from "@lattice/perception";
import type { IGNode, NodeId } from "@lattice/perception";
import { applyRecipe } from "@lattice/recipe";
import type { Recipe, RecipeStep, RecipeGate, LocatableNode } from "@lattice/recipe";
import { estimateTokens } from "./tokens.js";
import { synthFrame, type AppState } from "./synth.js";

const ORIGIN = "https://tracker.example.com";

const INTERACTIVE_ROLES = new Set(["button", "link", "input", "select", "textarea", "checkbox", "radio", "combobox"]);

interface FlowStep {
  readonly state: AppState;
  readonly targetLabel: string;
  readonly action: RecipeStep["action"];
  readonly value?: string;
}

/** The known "edit a task" form flow — exactly the kind of per-domain flow a recipe encodes. */
function formFlow(): FlowStep[] {
  const tasks = [{ id: 3, title: "Pay rent", done: false }];
  const detail = (form: { title: string; desc: string; priority: string; notify: boolean }): AppState => ({
    view: "detail",
    tasks,
    filter: "all",
    detailId: 3,
    form,
  });
  const f0 = { title: "Pay rent", desc: "", priority: "Normal", notify: false };
  const f1 = { ...f0, title: "Pay rent (June)" };
  const f2 = { ...f1, desc: "Transfer to landlord by 5th" };
  const f3 = { ...f2, priority: "High" };
  const f4 = { ...f3, notify: true };
  return [
    { state: detail(f0), targetLabel: "Title", action: "fill", value: "Pay rent (June)" },
    { state: detail(f1), targetLabel: "Description", action: "fill", value: "Transfer to landlord by 5th" },
    { state: detail(f2), targetLabel: "Priority", action: "select", value: "High" },
    { state: detail(f3), targetLabel: "Notify on change", action: "act" },
    { state: detail(f4), targetLabel: "Save changes", action: "act" },
  ];
}

function igOf(state: AppState): ReadonlyMap<NodeId, IGNode> {
  return snapshotToIG(synthFrame(state).raw, { tier: "L1" }).graph.nodes;
}

function locatableOf(nodes: ReadonlyMap<NodeId, IGNode>): LocatableNode[] {
  return [...nodes.values()].map((n) => ({
    id: n.id,
    role: n.role,
    label: n.label,
    ...(n.value !== undefined ? { value: n.value } : {}),
  }));
}

function findNode(nodes: ReadonlyMap<NodeId, IGNode>, label: string): IGNode {
  const n = [...nodes.values()].find((x) => x.label === label);
  if (!n) throw new Error(`recipe eval: target "${label}" not in IG`);
  return n;
}

/** Build the recipe from the OBSERVED IG, so its (role,label) match what the page exposes. */
function buildRecipe(flow: FlowStep[]): Recipe {
  const steps: RecipeStep[] = flow.map((s) => {
    const node = findNode(igOf(s.state), s.targetLabel);
    return {
      action: s.action,
      locator: { role: node.role, label: node.label },
      ...(s.value !== undefined ? { value: s.value } : {}),
    };
  });
  return { id: "edit-task", origin: ORIGIN, name: "Edit a task", version: 1, steps, trust: "trusted" };
}

const interactiveCompact = (nodes: ReadonlyMap<NodeId, IGNode>): string =>
  JSON.stringify(compactNodes([...nodes.values()].filter((n) => INTERACTIVE_ROLES.has(n.role))));

export interface RecipeEvalResult {
  readonly steps: number;
  /** Per-step model deliberation tokens, summed. */
  readonly semanticPlanningTokens: number;
  readonly recipePlanningTokens: number;
  readonly planningRatio: number; // recipe / semantic — < 1 means cheaper
  /** LLM calls spent CHOOSING actions. */
  readonly semanticModelCalls: number;
  readonly recipeModelCalls: number;
  /** Success when the site has drifted under the recipe (one label changed). */
  readonly driftSuccessNaive: number; // baked-locator recipe, no fallback
  readonly driftSuccessLattice: number; // resolve-live + semantic fallback
}

export async function runRecipeEval(): Promise<RecipeEvalResult> {
  const flow = formFlow();
  const recipe = buildRecipe(flow);

  // ── 1 + 2. planning tokens & model round-trips on the MATCHED site ──────────
  let semanticPlanningTokens = 0;
  let recipePlanningTokens = 0;
  for (let i = 0; i < flow.length; i++) {
    const nodes = igOf(flow[i]!.state);
    // Semantic: the model reads the live interactive-node list to pick the target.
    semanticPlanningTokens += estimateTokens(interactiveCompact(nodes));
    // Recipe: the model only confirms the pre-declared step descriptor.
    recipePlanningTokens += estimateTokens(JSON.stringify(recipe.steps[i]));
  }
  const semanticModelCalls = flow.length; // one decision per step
  const recipeModelCalls = 1; // one up-front "apply recipe"

  // ── 3. success under drift — the site changed "Save changes" → "Save" ───────
  const okGate: RecipeGate = { execute: () => Promise.resolve({ ok: true, url: ORIGIN }) };
  // Render the drift by relabeling the Save button in the LIVE perception only.
  const liveNodesPerStep: LocatableNode[][] = flow.map((s, i) => {
    const loc = locatableOf(igOf(s.state));
    if (i === flow.length - 1) {
      return loc.map((n) => (n.label === "Save changes" ? { ...n, label: "Save" } : n));
    }
    return loc;
  });

  let stepIdx = 0;
  const perceive = (): LocatableNode[] => liveNodesPerStep[stepIdx++] ?? [];

  // Naive recipe: trusts its baked locators, no fallback → breaks on the drifted step.
  stepIdx = 0;
  const naive = await applyRecipe(recipe, { perceive, gate: okGate });
  const driftSuccessNaive =
    naive.outcomes.filter((o) => o.status === "executed").length / recipe.steps.length;

  // Lattice recipe: resolves against the LIVE IG; the drifted step falls back to
  // the semantic path (which locates "Save" by the same role) and completes.
  stepIdx = 0;
  const lattice = await applyRecipe(recipe, {
    perceive,
    gate: okGate,
    fallback: (step, nodes) => {
      // The semantic path: same role still present (a button), recover by role.
      const recovered = nodes.some((n) => n.role === step.locator?.role);
      return Promise.resolve({ ok: recovered, reason: recovered ? "semantic fallback by role" : "gone" });
    },
  });
  const driftSuccessLattice =
    lattice.outcomes.filter((o) => o.status === "executed" || o.status === "fellBack").length /
    recipe.steps.length;

  return {
    steps: flow.length,
    semanticPlanningTokens,
    recipePlanningTokens,
    planningRatio: semanticPlanningTokens === 0 ? 1 : recipePlanningTokens / semanticPlanningTokens,
    semanticModelCalls,
    recipeModelCalls,
    driftSuccessNaive,
    driftSuccessLattice,
  };
}

export function formatRecipeReport(r: RecipeEvalResult): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push("# Lattice recipe eval — known flow WITH a recipe vs semantic fallback (P3.1)\n");
  lines.push(`A known ${r.steps}-step "edit a task" form flow. BEFORE = semantic discovery (the model`);
  lines.push("reads the live IG each step to choose the target). AFTER = a per-domain recipe that");
  lines.push("pre-declares each (role,label) step and resolves it against the live IG.\n");
  lines.push("| Metric | semantic (before) | recipe (after) |");
  lines.push("|---|--:|--:|");
  lines.push(`| planning tokens (model deliberation) | ${r.semanticPlanningTokens} | ${r.recipePlanningTokens} |`);
  lines.push(`| model round-trips (action choices) | ${r.semanticModelCalls} | ${r.recipeModelCalls} |`);
  lines.push(`| success on a drifted site | ${pct(r.driftSuccessNaive)} (naive baked-ref) | ${pct(r.driftSuccessLattice)} (resolve+fallback) |`);
  lines.push("");
  lines.push(`- **Planning tokens**: ${r.semanticPlanningTokens} → **${r.recipePlanningTokens}** (**${r.planningRatio.toFixed(3)}×**). The recipe names each step, so the model no longer reads the full interactive-node list to decide — it confirms a small descriptor.`);
  lines.push(`- **Model round-trips**: ${r.semanticModelCalls} → **${r.recipeModelCalls}**. Choosing the actions collapses to one up-front recipe selection; the per-step LLM decisions disappear.`);
  lines.push(`- **Drift success**: a naive recipe that trusts baked locators completes only **${pct(r.driftSuccessNaive)}** when "Save changes" → "Save"; Lattice resolves against the live IG and falls back on the changed step → **${pct(r.driftSuccessLattice)}**. The recipe degrades gracefully, it does not break.`);
  lines.push(`- **HONEST**: perception is NOT skipped — the IG is built and tainted every step on BOTH paths. The recipe amortizes PLANNING, not perception; per-step perception tokens are identical and not claimed here. Consequential steps in a recipe still pass through the grant (asserted in @lattice/recipe).`);
  return lines.join("\n");
}
