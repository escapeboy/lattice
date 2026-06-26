/**
 * Eval scenarios, resolved to a uniform shape: a list of perceive frames plus
 * the action targets at each frame. Two sources feed the same shape:
 *
 *  - FIXTURES — real captured agent-browser snapshots (single / few step). They
 *    exercise the single-page and the re-render (stable-identity) cases.
 *  - SYNTH — a 17-step project-tracker flow rendered from one ground-truth DOM
 *    model. This is the DELTA regime where the economics against the screenshot
 *    and raw-DOM (Chrome-method) baselines actually live.
 */

import { loadFrame } from "./fixtures.js";
import { synthFrame, taskTrackerFlow } from "./synth.js";
import type { EvalFrame } from "./frame.js";

export interface ResolvedScenario {
  readonly name: string;
  readonly description: string;
  readonly frames: ReadonlyArray<EvalFrame>;
  /** Per-frame action targets (accessible names the agent acts on). */
  readonly targets: ReadonlyArray<ReadonlyArray<string>>;
}

interface FixtureStep {
  readonly frame: string;
  readonly targets: ReadonlyArray<string>;
}
interface FixtureScenario {
  readonly name: string;
  readonly description: string;
  readonly steps: ReadonlyArray<FixtureStep>;
}

const FIXTURE_SCENARIOS: ReadonlyArray<FixtureScenario> = [
  {
    name: "account-form",
    description: "Single page, perceive once, fill 4 fields + submit (5 actions, 1 perceive).",
    steps: [{ frame: "A_form.json", targets: ["First", "Last", "Email", "Phone", "Save"] }],
  },
  {
    name: "spa-rerender",
    description: "Act on a list item; the list re-renders so agent-browser refs SHIFT; re-perceive and act again. The stable-identity case.",
    steps: [
      { frame: "B_list_before.json", targets: ["Edit five"] },
      { frame: "B_list_after.json", targets: ["Edit five"] },
    ],
  },
  {
    name: "large-page",
    description: "40-link page, perceive once, act on one deep link (verbose-IG cost case).",
    steps: [{ frame: "C_large.json", targets: ["Product number 37"] }],
  },
];

function resolveFixture(s: FixtureScenario): ResolvedScenario {
  return {
    name: s.name,
    description: s.description,
    frames: s.steps.map((st) => loadFrame(st.frame)),
    targets: s.steps.map((st) => st.targets),
  };
}

function resolveTaskTracker(): ResolvedScenario {
  const flow = taskTrackerFlow();
  return {
    name: "task-tracker-17step",
    description: "17-step project-tracker flow (load → grow → toggle → filter → detail form → submit → delete → settings). The delta regime.",
    frames: flow.map((s) => synthFrame(s.state)),
    targets: flow.map((s) => s.targets),
  };
}

export const SCENARIOS: ReadonlyArray<ResolvedScenario> = [
  ...FIXTURE_SCENARIOS.map(resolveFixture),
  resolveTaskTracker(),
];
