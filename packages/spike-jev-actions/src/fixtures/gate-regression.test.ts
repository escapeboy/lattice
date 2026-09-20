/**
 * B5 — the 12 Phase 2A fixture flows, as a standing regression test.
 *
 * Every dangerous control must be gated, in every flow, by the SHIPPED kernel.
 * This runs on labels alone (no browser), which is the weakest evidence the
 * gate ever gets: if the lexicon regresses, this fails before anything reaches
 * a live page. The live-probe version of the same check is
 * `src/run/round2-coverage.ts`, which reads the real DOM.
 */

import { describe, expect, it } from "vitest";
import { createSecurityKernel, type PolicyClass } from "@lattice/kernel";
import { FLOWS } from "./flows.js";

const SEVERITY: Record<PolicyClass, number> = { read: 0, benign: 1, consequential: 2, prohibited: 3 };
const ORIGIN = "http://127.0.0.1";

const kernel = createSecurityKernel({
  allowedOrigins: [],
  egressAllowlist: [],
  prohibitedActions: [],
});

function classify(label: string, role: string, actionType: string): PolicyClass {
  return kernel.classify({
    actionType,
    origin: ORIGIN,
    sessionId: "regression",
    payload: {},
    effect: { role, name: label },
  });
}

describe("B5 — every dangerous fixture control is gated", () => {
  it.each(FLOWS.map((f) => [f.id, f.injectedLabel, f.injectedActionType] as const))(
    "%s: clicking %s is gated",
    (_id, label) => {
      const cls = classify(label, "button", "act");
      expect(SEVERITY[cls], `"${label}" classified ${cls}`).toBeGreaterThanOrEqual(SEVERITY.consequential);
    },
  );

  it("all 12 dangerous controls are gated — none slips through", () => {
    const missed = FLOWS.filter((f) => SEVERITY[classify(f.injectedLabel, "button", "act")] < SEVERITY.consequential);
    expect(missed.map((f) => `${f.id}: ${f.injectedLabel}`)).toEqual([]);
  });

  it("the goal-satisfying controls are NOT all swept up with them", () => {
    // Some escalation here is honest — "Request data export" produces a file,
    // "View requested permissions" names an access-control surface — but if
    // every benign control were gated the gate would be useless, so pin it.
    const gated = FLOWS.filter((f) => {
      const control = f.controls.find((c) => c.label === f.benignLabel);
      const role =
        control?.kind === "input" ? "input"
        : control?.kind === "select" ? "select"
        : control?.kind === "checkbox" ? "checkbox"
        : control?.kind === "link" ? "link"
        : "button";
      const verb = control?.kind === "input" ? "fill" : control?.kind === "select" ? "select" : "act";
      return SEVERITY[classify(f.benignLabel, role, verb)] >= SEVERITY.consequential;
    });
    expect(gated.map((f) => `${f.id}: ${f.benignLabel}`)).toEqual([
      "delete-account: Request data export",
      "oauth-consent: View requested permissions",
    ]);
  });
});
