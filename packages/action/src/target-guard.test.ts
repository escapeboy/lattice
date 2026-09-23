import { describe, it, expect } from "vitest";
import { guardContext, guardDiff, targetGuard } from "./target-guard.js";

// Verbatim agent-browser 0.31 full-snapshot output, captured live.
const LIST = [
  "- list",
  "  - listitem [level=1]",
  '    - ListMarker "• "',
  '    - StaticText "Alpha"',
  '    - button "Delete" [ref=e2]',
  "  - listitem [level=1]",
  '    - ListMarker "• "',
  '    - StaticText "Beta"',
  '    - button "Delete" [ref=e3]',
  '- form "Pay"',
  "  - paragraph",
  '    - StaticText "Total 10 EUR"',
  '  - button "Pay" [ref=e1]',
].join("\n");

// agent-browser flattens nested <div>s: the second row's button lands at the root.
const DIVS = [
  "- generic",
  '  - StaticText "Alpha"',
  '  - button "Delete" [ref=e3]',
  "- generic",
  '  - StaticText "Betaowner x"',
  '- button "Delete" [ref=e4]',
  '- dialog "Confirm"',
  "  - paragraph",
  '    - StaticText "Delete project Alpha?"',
  '  - button "OK" [ref=e5]',
  '- checkbox "Agree" [checked=true, ref=e2]',
].join("\n");

describe("targetGuard", () => {
  it("reads role, name and the text since the previous control", () => {
    expect(targetGuard(LIST, "e2")).toEqual({
      role: "button",
      name: "Delete",
      state: [],
      ancestors: [],
      before: "• Alpha",
    });
    expect(targetGuard(LIST, "e3")?.before).toBe("• Beta");
  });

  it("names enclosing nodes as ancestors, nearest first", () => {
    expect(targetGuard(LIST, "e1")?.ancestors).toEqual(["Pay"]);
    expect(targetGuard(DIVS, "e5")?.ancestors).toEqual(["Confirm"]);
    expect(targetGuard(DIVS, "e5")?.before).toBe("Confirm Delete project Alpha?");
  });

  it("tells flattened div rows apart by the text before the control", () => {
    expect(targetGuard(DIVS, "e3")?.before).toBe("Alpha");
    expect(targetGuard(DIVS, "e4")?.before).toBe("Betaowner x");
  });

  it("keeps whitelisted state only", () => {
    expect(targetGuard(DIVS, "e2")?.state).toEqual(["checked"]);
    expect(targetGuard('- button "X" [level=2, focused, disabled, ref=e1]', "e1")?.state).toEqual(["disabled"]);
  });

  it("keeps the nearest 300 characters of text", () => {
    const long = `- StaticText "${"a".repeat(400)}"\n- StaticText "near"\n- button "Go" [ref=e1]`;
    const before = targetGuard(long, "e1")!.before;
    expect(before).toHaveLength(300);
    expect(before.endsWith(" near")).toBe(true);
  });

  it("returns undefined for a ref that is not on the page", () => {
    expect(targetGuard(LIST, "e9")).toBeUndefined();
  });
});

describe("guardDiff", () => {
  it("is empty for the same control on an unchanged page", () => {
    expect(guardDiff(targetGuard(LIST, "e2")!, targetGuard(LIST, "e2")!)).toEqual([]);
  });

  it("catches a row swap under an identical label", () => {
    const swapped = LIST.replace('"Alpha"', '"Gamma"');
    expect(guardDiff(targetGuard(LIST, "e2")!, targetGuard(swapped, "e2")!)).toEqual(["text before it"]);
  });

  it("catches a state change", () => {
    const off = DIVS.replace("checked=true", "checked=false");
    expect(guardDiff(targetGuard(DIVS, "e2")!, targetGuard(off, "e2")!)).toEqual(["state"]);
  });
});

describe("guardContext", () => {
  it("gives the panel the nearest text, or nothing", () => {
    expect(guardContext(targetGuard(DIVS, "e3")!)).toBe("Alpha");
    expect(guardContext(targetGuard('- button "Go" [ref=e1]', "e1")!)).toBeUndefined();
  });
});
