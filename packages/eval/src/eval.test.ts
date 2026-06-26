/**
 * Eval harness — runs deterministically in CI over fixtures + the synthetic
 * flow. Asserts the harness is correct and self-consistent (NOT a particular
 * gate outcome — the verdict is the finding, reported separately), plus the
 * load-bearing claims: Lattice beats the Chrome method on tokens, and stable
 * identity survives caching where per-snapshot refs do not.
 */

import { describe, it, expect } from "vitest";
import { runEval, formatReport } from "./report.js";
import { SCENARIOS } from "./scenarios.js";
import { refByLabel } from "./frame.js";
import {
  render,
  renderAx,
  renderHtml,
  synthFrame,
  taskTrackerFlow,
} from "./synth.js";

describe("eval harness — scenarios resolve and parse", () => {
  it("every scenario's frames carry refs, a11y text, and HTML; targets exist", () => {
    for (const s of SCENARIOS) {
      expect(s.frames.length).toBeGreaterThan(0);
      for (let i = 0; i < s.frames.length; i++) {
        const f = s.frames[i]!;
        expect(Object.keys(f.refs).length).toBeGreaterThan(0);
        expect(f.snapshotText.length).toBeGreaterThan(0);
        expect(f.html.length).toBeGreaterThan(0);
        for (const target of s.targets[i] ?? []) {
          expect(refByLabel(f, target), `${s.name}[${i}] has ${target}`).not.toBeNull();
        }
      }
    }
  });

  it("the re-render fixture genuinely churns refs (precondition of the reliability test)", () => {
    const spa = SCENARIOS.find((s) => s.name === "spa-rerender")!;
    const before = spa.frames[0]!;
    const after = spa.frames[1]!;
    expect(refByLabel(before, "Edit three")).not.toBe(refByLabel(after, "Edit three"));
  });

  it("the synthetic flow is a real multi-step DELTA scenario (15+ steps)", () => {
    const flow = SCENARIOS.find((s) => s.name === "task-tracker-17step")!;
    expect(flow.frames.length).toBeGreaterThanOrEqual(15);
  });
});

describe("synth model — three faithful representations from one tree", () => {
  it("renderHtml is the heaviest, a11y text is terse, both describe the same state", () => {
    const flow = taskTrackerFlow();
    const root = render(flow[0]!.state);
    const html = renderHtml(root);
    const { text } = renderAx(root);
    // Raw DOM carries realistic wrapper overhead → larger than the a11y text.
    expect(html.length).toBeGreaterThan(text.length);
    // Both mention the same actionable label.
    expect(html).toContain("Add task");
    expect(text).toContain("Add task");
  });

  it("synthFrame produces a parseable agent-browser snapshot", () => {
    const f = synthFrame(taskTrackerFlow()[0]!.state);
    expect(f.snapshotText).toMatch(/\[ref=e\d+\]/);
    expect(refByLabel(f, "Add task")).not.toBeNull();
  });
});

describe("eval harness — metrics are computed and self-consistent", () => {
  it("produces positive, deterministic token counts for all four systems", () => {
    const a = runEval();
    const b = runEval();
    expect(a.verdict.latticeTokens).toBeGreaterThan(0);
    expect(a.verdict.screenshotTokens).toBeGreaterThan(0);
    expect(a.verdict.rawDomTokens).toBeGreaterThan(0);
    expect(a.verdict.agentBrowserTokens).toBeGreaterThan(0);
    expect(a.verdict.latticeTokens).toBe(b.verdict.latticeTokens); // deterministic
  });

  it("LATTICE BEATS THE CHROME METHOD on tokens (the gate)", () => {
    const v = runEval().verdict;
    expect(v.beatsScreenshot).toBe(true);
    expect(v.beatsRawDom).toBe(true);
    expect(v.pass).toBe(true);
  });

  it("RELIABILITY: stable identity survives caching where per-snapshot refs do not", () => {
    const v = runEval().verdict;
    expect(v.latticeNaiveAccuracy).toBe(1);
    expect(v.abNaiveAccuracy).toBeLessThan(1);
  });

  it("renders a gate report with a verdict and a totals row", () => {
    const text = formatReport(runEval());
    expect(text).toContain("GATE:");
    expect(text).toContain("TOTAL");
    expect(text).toContain("screenshot");
  });
});
