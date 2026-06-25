import { describe, it, expect } from "vitest";
import { createPerceptionEngine } from "./index.js";
import type { FidelityTier, IGNode, NodeId } from "./index.js";

describe("@lattice/perception scaffold", () => {
  it("FidelityTier covers L0-L3", () => {
    const tiers: FidelityTier[] = ["L0", "L1", "L2", "L3"];
    expect(tiers).toHaveLength(4);
  });

  it("IGNode type is structurally sound", () => {
    const node: IGNode = {
      id: "n-1" as NodeId,
      role: "button",
      label: "Submit",
      state: { disabled: false, hidden: false },
      relations: [],
    };
    expect(node.label).toBe("Submit");
  });

  it("createPerceptionEngine throws NotImplemented until S2", () => {
    expect(() => createPerceptionEngine()).toThrow("Not implemented");
  });
});
