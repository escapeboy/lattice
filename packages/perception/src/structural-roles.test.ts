import { describe, it, expect } from "vitest";
import { snapshotToIG } from "./from-snapshot.js";
import type { RawSnapshot } from "@lattice/engine-adapter";

function snap(tree: string): RawSnapshot {
  return { url: "https://example.com/", tree, refs: [] };
}

// smoke gap #1b: structural/content roles (table/cell/iframe/code/article/text)
// were dropped by the ROLE_MAP allowlist — up to ~28% of nodes on table pages,
// docs code samples, and security-relevant iframe boundaries went invisible.
const TREE = [
  '- table "Stats"',
  '  - row "Header"',
  '    - cell "Name"',
  '    - cell "Value"',
  '- iframe "Consent"',
  '  - button "Accept" [ref=e1]',
  '- code "example()"',
  '- article "Post"',
  '  - paragraph "Body text"',
].join("\n");

describe("structural roles (#1b)", () => {
  it("L2 surfaces table/cell/iframe/code/article/text content", () => {
    const { graph } = snapshotToIG(snap(TREE), { tier: "L2" });
    const roles = [...graph.nodes.values()].map((n) => n.role);
    for (const r of ["table", "row", "cell", "iframe", "code", "article", "text"]) {
      expect(roles, `L2 should include ${r}`).toContain(r);
    }
    // the iframe boundary itself is now visible (consent/payment frames)
    expect([...graph.nodes.values()].some((n) => n.role === "iframe" && n.label === "Consent")).toBe(true);
  });

  it("L1 still filters non-interactive structural roles (token economy preserved)", () => {
    const { graph } = snapshotToIG(snap(TREE), { tier: "L1" });
    const roles = new Set([...graph.nodes.values()].map((n) => n.role));
    expect(roles.has("button"), "interactive control stays on L1").toBe(true);
    for (const r of ["table", "row", "cell", "code", "article", "text"]) {
      expect(roles.has(r as never), `L1 should NOT include ${r}`).toBe(false);
    }
  });
});
