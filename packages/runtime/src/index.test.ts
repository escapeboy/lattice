import { describe, it, expect } from "vitest";
import { createRuntimeScheduler } from "./index.js";
import type { ResourceBudget, SessionTopology } from "./index.js";

describe("@lattice/runtime scaffold", () => {
  it("ResourceBudget is typed correctly", () => {
    const budget: ResourceBudget = { maxContexts: 10, maxMemoryMb: 2048, maxCpuPercent: 80 };
    expect(budget.maxContexts).toBe(10);
  });

  it("SessionTopology covers all variants", () => {
    const topologies: SessionTopology[] = ["ephemeral", "persistent", "pooled"];
    expect(topologies).toHaveLength(3);
  });

  it("createRuntimeScheduler throws NotImplemented until S4", () => {
    const budget: ResourceBudget = { maxContexts: 1, maxMemoryMb: 512, maxCpuPercent: 50 };
    expect(() => createRuntimeScheduler(budget)).toThrow("Not implemented");
  });
});
