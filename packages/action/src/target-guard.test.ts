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
      after: "• Beta Delete",
    });
    expect(targetGuard(LIST, "e3")?.before).toBe("Delete • Beta");
  });

  it("names enclosing nodes as ancestors, nearest first", () => {
    expect(targetGuard(LIST, "e1")?.ancestors).toEqual(["Pay"]);
    expect(targetGuard(DIVS, "e5")?.ancestors).toEqual(["Confirm"]);
    expect(targetGuard(DIVS, "e5")?.before).toBe("Delete Confirm Delete project Alpha?");
  });

  it("tells flattened div rows apart by the text before the control", () => {
    expect(targetGuard(DIVS, "e3")?.before).toBe("Alpha");
    expect(targetGuard(DIVS, "e4")?.before).toBe("Delete Betaowner x");
  });

  // Verbatim agent-browser 0.31: a row named by a link, and a heading, both
  // carry their own ref. The guard must still see the row's name.
  const NAMED_BY_CONTROL = (a: string, b: string): string =>
    [
      "- list",
      "  - listitem [level=1]",
      '    - ListMarker "• "',
      `    - link "${a}" [ref=e4]`,
      '    - button "Delete" [ref=e5]',
      "  - listitem [level=1]",
      '    - ListMarker "• "',
      `    - link "${b}" [ref=e6]`,
      '    - button "Delete" [ref=e7]',
      `- heading "${a}" [level=3, ref=e1]`,
      '- button "Delete" [ref=e2]',
    ].join("\n");

  it("keeps the name of a neighbouring control that names the row", () => {
    expect(targetGuard(NAMED_BY_CONTROL("Alpha", "Beta"), "e5")?.before).toBe("Alpha");
    expect(targetGuard(NAMED_BY_CONTROL("Alpha", "Beta"), "e2")?.before).toBe("Alpha");
    const before = targetGuard(NAMED_BY_CONTROL("Alpha", "Beta"), "e5")!;
    const swapped = targetGuard(NAMED_BY_CONTROL("Gamma", "Alpha"), "e5")!;
    expect(guardDiff(before, swapped)).toEqual(["text before it", "text after it"]);
  });

  it("keeps whitelisted state only", () => {
    expect(targetGuard(DIVS, "e2")?.state).toEqual(["checked"]);
    expect(targetGuard('- button "X" [level=2, focused, disabled, ref=e1]', "e1")?.state).toEqual(["disabled"]);
  });

  it("tells a mixed checkbox from a checked one", () => {
    // Verbatim agent-browser 0.31 for an indeterminate checkbox.
    const mixed = targetGuard('- checkbox "all" [checked=mixed, ref=e3]', "e3")!;
    const checked = targetGuard('- checkbox "all" [checked=true, ref=e3]', "e3")!;
    expect(mixed.state).toEqual(["checked=mixed"]);
    expect(guardDiff(mixed, checked)).toEqual(["state"]);
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

// Verbatim agent-browser 0.31 output for <li><button>Delete</button> <span>Alpha</span></li>.
const LABEL_AFTER = (a: string, b: string): string =>
  [
    "- list",
    "  - listitem [level=1]",
    '    - ListMarker "• "',
    '    - button "Delete" [ref=e1]',
    `    - StaticText "${a}"`,
    "  - listitem [level=1]",
    '    - ListMarker "• "',
    '    - button "Delete" [ref=e2]',
    `    - StaticText "${b}"`,
  ].join("\n");

describe("guardDiff", () => {
  it("catches a row swap when the row names itself after the button", () => {
    const before = targetGuard(LABEL_AFTER("Alpha", "Beta"), "e1")!;
    const after = targetGuard(LABEL_AFTER("Gamma", "Alpha"), "e1")!;
    expect(guardDiff(before, after)).toEqual(["text after it"]);
  });

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
  it("gives the panel the text on both sides of the control, or nothing", () => {
    expect(guardContext(targetGuard(DIVS, "e3")!)).toBe("Alpha [here] Betaowner x Delete");
    expect(guardContext(targetGuard('- button "Go" [ref=e1]', "e1")!)).toBeUndefined();
    // Only a bullet before the button: the row's name comes after it.
    expect(guardContext(targetGuard(LABEL_AFTER("Alpha", "Beta"), "e1")!)).toBe("[here] Alpha Delete");
  });

  it("does not name only the previous row when the row names itself after the button", () => {
    // Beta's Delete: the text before it is Alpha's row. One side alone would
    // show the human "Alpha" for a click on Beta.
    expect(guardContext(targetGuard(LABEL_AFTER("Alpha", "Beta"), "e2")!)).toBe("Delete Alpha [here] Beta");
  });
});
