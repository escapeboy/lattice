import { describe, it, expect } from "vitest";
import { taint, createSecurityKernel } from "./index.js";
import type { PolicyClass, TaintedStr } from "./index.js";

describe("@lattice/kernel scaffold", () => {
  it("taint() produces TaintedStr at runtime", () => {
    const t: TaintedStr = taint("injected content");
    expect(typeof t).toBe("string");
    expect(t).toBe("injected content");
  });

  it("PolicyClass covers all variants", () => {
    const classes: PolicyClass[] = ["read", "benign", "consequential", "prohibited"];
    expect(classes).toHaveLength(4);
  });

  it("createSecurityKernel throws NotImplemented until S5", () => {
    expect(() => createSecurityKernel()).toThrow("Not implemented");
  });
});
