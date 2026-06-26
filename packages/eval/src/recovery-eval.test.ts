/**
 * Recovery eval (P2.1) — asserts the measurable before/after improvement and the
 * boundedness, driven by real snapshotToIG fingerprints + the real ladder.
 */

import { describe, it, expect } from "vitest";
import { runRecoveryEval, formatRecoveryReport } from "./recovery-eval.js";

describe("recovery eval — bounded ladder beats re-anchor-only, measurably", () => {
  it("the ladder strictly improves resolved success rate over the baseline", () => {
    const r = runRecoveryEval();
    expect(r.recoverySuccess).toBeGreaterThan(r.baselineSuccess);
  });

  it("baseline (re-anchor only) handles 'moved' but not restructured/relabeled/disappeared", () => {
    const r = runRecoveryEval();
    const byName = Object.fromEntries(r.rows.map((row) => [row.scenario, row]));
    expect(byName["moved"]!.baselineResolved).toBe(true);
    expect(byName["restructured"]!.baselineResolved).toBe(false);
    expect(byName["relabeled"]!.baselineResolved).toBe(false);
    expect(byName["disappeared"]!.baselineResolved).toBe(false);
  });

  it("the ladder resolves restructured (alt-locator) and relabeled (L3), and hands off the gone one", () => {
    const r = runRecoveryEval();
    const byName = Object.fromEntries(r.rows.map((row) => [row.scenario, row]));
    expect(byName["restructured"]!.rung).toBe("alt_locator");
    expect(byName["restructured"]!.recoveryResolved).toBe(true);
    expect(byName["relabeled"]!.rung).toBe("l3_vision");
    expect(byName["relabeled"]!.recoveryResolved).toBe(true);
    expect(byName["disappeared"]!.rung).toBe("handoff");
    expect(byName["disappeared"]!.recoveryHandoff).toBe(true);
  });

  it("is single-pass — zero blind retry loops", () => {
    expect(runRecoveryEval().blindLoops).toBe(0);
  });

  it("renders a report with before/after numbers", () => {
    const text = formatRecoveryReport(runRecoveryEval());
    expect(text).toContain("BEFORE");
    expect(text).toContain("AFTER");
  });
});
