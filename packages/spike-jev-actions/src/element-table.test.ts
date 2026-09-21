import { describe, expect, it } from "vitest";
import { buildElementTable, MAX_OPTIONS } from "./element-table.js";
import { buildRequest } from "./questions.js";
import { igFixture, VIEWPORT, type NodeSpec } from "./test-support.js";

describe("element table", () => {
  it("keeps only interactable, enabled, visible nodes", () => {
    const ig = igFixture([
      { role: "button", label: "Save" },
      { role: "heading", label: "Settings" },
      { role: "button", label: "Hidden one", hidden: true },
      { role: "button", label: "Disabled one", disabled: true },
      { role: "input", label: "Email" },
    ]);
    const table = buildElementTable(ig, VIEWPORT);
    expect(table.elements.map((e) => e.label)).toEqual(["Save", "Email"]);
  });

  it("offers a target head only when that operation has a valid target", () => {
    const ig = igFixture([{ role: "button", label: "Save" }]);
    const table = buildElementTable(ig, VIEWPORT);
    expect(table.availableTargeted).toEqual(["CLICK"]);

    const built = buildRequest({ ig, table, goal: "Save the form.", recentActions: [] });
    expect(built.request.questions["click_target"]).toBeDefined();
    expect(built.request.questions["type_text_target"]).toBeUndefined();
    expect(built.request.questions["select_target"]).toBeUndefined();
    expect(built.offeredOperations).not.toContain("TYPE_TEXT");
    expect(built.offeredOperations).not.toContain("SELECT");
  });

  it("drops nodes beyond one viewport height from the fold", () => {
    const ig = igFixture([
      { role: "button", label: "Near", y: 900 },
      { role: "button", label: "Far", y: 5000 },
    ]);
    const table = buildElementTable(ig, VIEWPORT);
    expect(table.elements.map((e) => e.label)).toEqual(["Near"]);
  });

  it("caps a target head at 255 options including other", () => {
    const specs: NodeSpec[] = Array.from({ length: 400 }, (_, i) => ({
      role: "button" as const,
      label: `Button ${i}`,
      y: 100,
    }));
    const ig = igFixture(specs);
    const table = buildElementTable(ig, VIEWPORT);
    const built = buildRequest({ ig, table, goal: "Click something.", recentActions: [] });
    const click = built.request.questions["click_target"] as { criteria: Record<string, string> };
    expect(Object.keys(click.criteria).length).toBeLessThanOrEqual(MAX_OPTIONS);
    expect(table.truncated).toBeGreaterThan(0);
  });

  it("trims state rather than relying on API truncation", () => {
    // 254 rows each carrying a trimmed label + value + placeholder overflows the
    // 24k-token state budget, so the builder must drop rows to fit.
    const specs: NodeSpec[] = Array.from({ length: 254 }, (_, i) => ({
      role: "input" as const,
      label: `Very long control label number ${i} `.repeat(20),
      value: `Very long current field value number ${i} `.repeat(20),
      placeholder: `Placeholder text number ${i} `.repeat(10),
      y: 100,
    }));
    const ig = igFixture(specs);
    const table = buildElementTable(ig, VIEWPORT);
    const built = buildRequest({ ig, table, goal: "Click something.", recentActions: [] });
    expect(built.stateTokensEstimate).toBeLessThanOrEqual(24_000);
    expect(built.trimmedElements).toBeGreaterThan(0);
  });

  it("keeps state inside the budget even when nothing needs trimming", () => {
    const ig = igFixture([{ role: "button", label: "Save" }]);
    const table = buildElementTable(ig, VIEWPORT);
    const built = buildRequest({ ig, table, goal: "Save the form.", recentActions: [] });
    expect(built.stateTokensEstimate).toBeLessThanOrEqual(24_000);
    expect(built.trimmedElements).toBe(0);
  });
});
