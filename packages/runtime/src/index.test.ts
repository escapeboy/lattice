import { describe, it, expect } from "vitest";
import { createRuntimeScheduler } from "./index.js";
import type { ResourceBudget, SessionTopology } from "./index.js";

describe("@lattice/runtime — unit", () => {
  it("ResourceBudget is typed correctly", () => {
    const budget: ResourceBudget = { maxContexts: 10, maxMemoryMb: 2048, maxCpuPercent: 80 };
    expect(budget.maxContexts).toBe(10);
  });

  it("SessionTopology covers all variants", () => {
    const topologies: SessionTopology[] = ["ephemeral", "persistent", "pooled"];
    expect(topologies).toHaveLength(3);
  });

  it("createRuntimeScheduler returns scheduler with correct interface", () => {
    const budget: ResourceBudget = { maxContexts: 1, maxMemoryMb: 512, maxCpuPercent: 50 };
    const scheduler = createRuntimeScheduler(null as never, budget);
    expect(typeof scheduler.createContext).toBe("function");
    expect(typeof scheduler.fanOut).toBe("function");
    expect(typeof scheduler.snapshotContext).toBe("function");
    expect(typeof scheduler.restoreContext).toBe("function");
    expect(typeof scheduler.activeCount).toBe("function");
    expect(scheduler.activeCount()).toBe(0);
  });

  it("activeCount() is 0 before any contexts are created", () => {
    const scheduler = createRuntimeScheduler(null as never, {
      maxContexts: 5, maxMemoryMb: 1024, maxCpuPercent: 50,
    });
    expect(scheduler.activeCount()).toBe(0);
  });
});
