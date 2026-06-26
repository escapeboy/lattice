/**
 * S2 build-on perception tests (ADR 0002). The headline test is identity
 * stability across agent-browser ref churn — the differentiation their
 * per-snapshot refs cannot provide.
 */

import { describe, it, expect } from "vitest";
import { snapshotToIG, parseSnapshotTree, igDelta } from "./from-snapshot.js";
import type { RawSnapshot } from "@lattice/engine-adapter";

function snap(tree: string, url = "https://example.com/"): RawSnapshot {
  // refs map is not needed for IG identity; the tree carries [ref=eN].
  return { url, tree, refs: [] };
}

describe("snapshotToIG — Lattice IG from agent-browser snapshot", () => {
  it("parses an indented tree into roles, names, refs, and flags", () => {
    const lines = parseSnapshotTree(
      [
        '- navigation "Main"',
        '  - link "Home" [ref=e1]',
        '  - button "Menu" [ref=e2] [expanded]',
        '- textbox "Email" [ref=e3] [required]',
      ].join("\n"),
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatchObject({ rawRole: "link", name: "Home", ref: "e1" });
    expect(lines[2]?.flags.has("expanded")).toBe(true);
    expect(lines[3]?.flags.has("required")).toBe(true);
  });

  it("maps interactive nodes to IGNodes with a re-anchoring ref map", () => {
    const { graph, refMap } = snapshotToIG(
      snap('- button "Submit" [ref=e1]\n- link "Help" [ref=e2]'),
    );
    expect(graph.nodes.size).toBe(2);
    const ids = [...graph.nodes.keys()];
    expect(refMap.get(ids[0]!)).toBe("e1");
    expect(refMap.get(ids[1]!)).toBe("e2");
    expect([...graph.nodes.values()].map((n) => n.role)).toEqual(["button", "link"]);
  });

  it("STABLE IDENTITY: same element keeps its NodeId across ref churn (the differentiation)", () => {
    // Same page, re-rendered: agent-browser assigns DIFFERENT refs.
    const before = snapshotToIG(snap('- button "Submit" [ref=e1]\n- textbox "Email" [ref=e2]'));
    const after = snapshotToIG(snap('- button "Submit" [ref=e7]\n- textbox "Email" [ref=e9]'));

    const beforeIds = [...before.graph.nodes.keys()].sort();
    const afterIds = [...after.graph.nodes.keys()].sort();
    // Lattice NodeIds are identical despite the ref change…
    expect(afterIds).toEqual(beforeIds);
    // …while the underlying agent-browser refs differ.
    const submitId = [...before.graph.nodes.values()].find((n) => n.role === "button")!.id;
    expect(before.refMap.get(submitId)).toBe("e1");
    expect(after.refMap.get(submitId)).toBe("e7");
  });

  it("TAINT: every node is page-origin → tainted, with its label field marked", () => {
    const { graph, taint } = snapshotToIG(snap('- button "Click me" [ref=e1]'));
    for (const id of graph.nodes.keys()) {
      expect(taint.get(id)?.origin).toBe("page-content");
    }
    const id = [...graph.nodes.keys()][0]!;
    expect(taint.get(id)?.fields).toContain("label");
  });

  it("L1 keeps interactive + heading + landmark; drops generic structure", () => {
    const { graph } = snapshotToIG(
      snap(
        [
          '- generic',
          '  - heading "Title"',
          '  - button "Go" [ref=e1]',
          '  - list',
          '    - listitem "x"',
        ].join("\n"),
      ),
      { tier: "L1" },
    );
    const roles = [...graph.nodes.values()].map((n) => n.role).sort();
    expect(roles).toContain("button");
    expect(roles).toContain("heading");
    expect(roles).not.toContain("listitem"); // dropped at L1
  });

  it("ordinal disambiguates two same-role same-name elements into distinct ids", () => {
    const { graph } = snapshotToIG(snap('- button "OK" [ref=e1]\n- button "OK" [ref=e2]'));
    expect(graph.nodes.size).toBe(2);
  });

  it("serializedSize is the byte length of the L1 graph and stays small", () => {
    const { graph } = snapshotToIG(snap('- button "Submit" [ref=e1]'));
    expect(graph.serializedSize).toBeGreaterThan(0);
    expect(graph.serializedSize).toBeLessThan(5000);
  });
});

describe("igDelta — stable-id delta (delta streaming basis)", () => {
  it("a pure ref-churn re-render yields an EMPTY delta", () => {
    const a = snapshotToIG(snap('- button "Submit" [ref=e1]')).graph;
    const b = snapshotToIG(snap('- button "Submit" [ref=e9]')).graph;
    const d = igDelta(a, b);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.updated).toHaveLength(0);
  });

  it("detects added, removed, and state-updated nodes", () => {
    const a = snapshotToIG(snap('- button "A" [ref=e1]\n- button "B" [ref=e2]')).graph;
    const b = snapshotToIG(snap('- button "A" [ref=e1] [disabled]\n- link "C" [ref=e3]')).graph;
    const d = igDelta(a, b);
    expect(d.added.map((n) => n.label)).toContain("C");
    expect(d.updated.map((n) => n.label)).toContain("A"); // gained [disabled]
    expect(d.removed).toHaveLength(1); // B gone
  });
});
