/**
 * S5.5 eval harness — runs deterministically in CI over the captured fixtures.
 * Asserts the harness is correct and self-consistent (NOT a particular gate
 * outcome — the verdict is the finding, reported separately).
 */

import { describe, it, expect } from "vitest";
import { runEval, formatReport } from "./report.js";
import { runScenario } from "./runners.js";
import { SCENARIOS } from "./scenarios.js";
import { loadFrame, refByLabel } from "./fixtures.js";

describe("eval harness — fixtures load and parse", () => {
  it("every scenario's frames load with refs + snapshot text", () => {
    for (const s of SCENARIOS) {
      for (const step of s.steps) {
        const f = loadFrame(step.frame);
        expect(Object.keys(f.refs).length).toBeGreaterThan(0);
        expect(f.snapshotText.length).toBeGreaterThan(0);
        for (const target of step.targets) {
          expect(refByLabel(f, target), `${step.frame} has ${target}`).not.toBeNull();
        }
      }
    }
  });

  it("the re-render fixtures genuinely churn refs (precondition of the success test)", () => {
    const before = loadFrame("B_list_before.json");
    const after = loadFrame("B_list_after.json");
    expect(refByLabel(before, "Edit three")).not.toBe(refByLabel(after, "Edit three"));
  });
});

describe("eval harness — metrics are computed and self-consistent", () => {
  it("produces positive, deterministic token counts for both systems", () => {
    const a = runEval();
    const b = runEval();
    expect(a.verdict.latticeTokens).toBeGreaterThan(0);
    expect(a.verdict.abFullTokens).toBeGreaterThan(0);
    expect(a.verdict.latticeTokens).toBe(b.verdict.latticeTokens); // deterministic
  });

  it("STABLE IDENTITY: Lattice resolves re-render actions where naive ref-caching fails", () => {
    const r = runScenario(SCENARIOS.find((s) => s.name === "spa-rerender")!);
    // Lattice addresses by stable id → 100% resolved across the re-render.
    expect(r.lattice.accuracy).toBe(1);
    // A naive agent that cached the first-seen ref mis-targets after the churn.
    expect(r.abNaiveAccuracy).toBeLessThan(1);
    // A FAIR agent-browser baseline that re-finds by label also succeeds.
    expect(r.abFull.accuracy).toBe(1);
  });

  it("renders a gate report with a verdict and a totals row", () => {
    const report = runEval();
    const text = formatReport(report);
    expect(text).toContain("GATE:");
    expect(text).toContain("TOTAL");
    expect(typeof report.verdict.pass).toBe("boolean");
  });
});
