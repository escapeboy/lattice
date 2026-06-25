import { describe, it, expect } from "vitest";
import { computeNodeId } from "./index.js";
import { PerceptionEngineImpl } from "./engine.js";
import type { FidelityTier, IGNode, InteractionGraph, NodeId } from "./index.js";

describe("@lattice/perception — identity", () => {
  it("computeNodeId produces role-prefixed deterministic string", () => {
    const id = computeNodeId({ role: "button", axName: "Submit", ancestorRoles: ["landmark"], ordinal: 0 });
    expect(id).toMatch(/^button-[0-9a-f]{12}$/);
  });

  it("same inputs → same ID (stable)", () => {
    const input = { role: "link" as const, axName: "Learn more", ancestorRoles: ["landmark"], ordinal: 0 };
    expect(computeNodeId(input)).toBe(computeNodeId(input));
  });

  it("different ordinal → different ID", () => {
    const base = { role: "button" as const, axName: "OK", ancestorRoles: [] as string[], ordinal: 0 };
    const id0 = computeNodeId(base);
    const id1 = computeNodeId({ ...base, ordinal: 1 });
    expect(id0).not.toBe(id1);
  });

  it("stable explicit id wins over positional ordinal", () => {
    const base = { role: "button" as const, axName: "OK", ancestorRoles: [] as string[], ordinal: 99 };
    const withId = computeNodeId({ ...base, explicitId: "submit-btn" });
    const withId2 = computeNodeId({ ...base, explicitId: "submit-btn", ordinal: 0 });
    expect(withId).toBe(withId2);
  });
});

describe("@lattice/perception — FidelityTier", () => {
  it("covers L0-L3", () => {
    const tiers: FidelityTier[] = ["L0", "L1", "L2", "L3"];
    expect(tiers).toHaveLength(4);
  });
});

describe("@lattice/perception — delta", () => {
  function makeNode(id: string, label: string): IGNode {
    return {
      id: id as NodeId,
      role: "button",
      label,
      state: { disabled: false, hidden: false },
      relations: [],
    };
  }

  function makeGraph(nodes: IGNode[]): InteractionGraph {
    const map = new Map<NodeId, IGNode>(nodes.map((n) => [n.id, n]));
    return {
      tier: "L1",
      url: "https://example.com",
      title: "Test",
      nodes: map,
      nodeOrder: nodes.map((n) => n.id),
      serializedSize: 0,
    };
  }

  it("delta returns empty when snapshots are identical", () => {
    const engine = new PerceptionEngineImpl(null as never);
    const n = makeNode("btn-1", "Submit");
    const g = makeGraph([n]);
    const d = engine.delta(g, g);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.updated).toHaveLength(0);
  });

  it("delta detects added node", () => {
    const engine = new PerceptionEngineImpl(null as never);
    const prev = makeGraph([makeNode("btn-1", "Submit")]);
    const next = makeGraph([makeNode("btn-1", "Submit"), makeNode("btn-2", "Cancel")]);
    const d = engine.delta(prev, next);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]?.id).toBe("btn-2");
  });

  it("delta detects removed node", () => {
    const engine = new PerceptionEngineImpl(null as never);
    const prev = makeGraph([makeNode("btn-1", "Submit"), makeNode("btn-2", "Cancel")]);
    const next = makeGraph([makeNode("btn-1", "Submit")]);
    const d = engine.delta(prev, next);
    expect(d.removed).toContain("btn-2" as NodeId);
  });

  it("delta detects updated node (label changed)", () => {
    const engine = new PerceptionEngineImpl(null as never);
    const prev = makeGraph([makeNode("btn-1", "Submit")]);
    const next = makeGraph([makeNode("btn-1", "Submitting…")]);
    const d = engine.delta(prev, next);
    expect(d.updated).toHaveLength(1);
    expect(d.updated[0]?.label).toBe("Submitting…");
  });

  it("delta shows only changed nodes", () => {
    const engine = new PerceptionEngineImpl(null as never);
    const n1 = makeNode("btn-1", "Submit");
    const n2 = makeNode("btn-2", "Cancel");
    const n3Changed = makeNode("btn-3", "Updated");
    const prev = makeGraph([n1, n2, makeNode("btn-3", "Original")]);
    const next = makeGraph([n1, n2, n3Changed]);
    const d = engine.delta(prev, next);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.updated).toHaveLength(1);
    expect(d.updated[0]?.label).toBe("Updated");
  });
});
