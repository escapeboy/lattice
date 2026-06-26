/**
 * Eval scenarios — each is a sequence of perceive points (snapshots) plus the
 * action targets the agent must resolve at each point. Built from real captured
 * agent-browser snapshots. Chosen to exercise where Lattice could differ from
 * the bare engine: a single-page form (no re-perceive), an SPA re-render where
 * refs churn (the stable-identity case), and a large page (verbose IG cost).
 */

export interface EvalStep {
  /** Fixture file the agent perceives at this step. */
  readonly frame: string;
  /** Accessible names the agent must act on at this perceive point. */
  readonly targets: ReadonlyArray<string>;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly steps: ReadonlyArray<EvalStep>;
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: "account-form",
    description: "Single page, perceive once, fill 4 fields + submit (5 actions, 1 perceive).",
    steps: [{ frame: "A_form.json", targets: ["First", "Last", "Email", "Phone", "Save"] }],
  },
  {
    name: "spa-rerender",
    description:
      "Act on a list item; the list re-renders (an item removed) so agent-browser refs SHIFT; re-perceive and act again. The stable-identity case.",
    steps: [
      // Act on "Edit five", then the list re-renders (first item removed) and we
      // act on the SAME element again — its agent-browser ref churns e5→e4, so a
      // cached ref now mis-targets, while the stable NodeId still resolves it.
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
