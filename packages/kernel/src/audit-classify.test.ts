import { describe, it, expect } from "vitest";
import { createSecurityKernel } from "./index.js";
import { CONSTITUTIONAL_FLOOR } from "./operator.js";

// Audit GAP #1: classify() must enforce the floor list itself, not a stale copy.
describe("classify — every constitutional-floor primitive is prohibited (no stale proxy list)", () => {
  it("classifies every CONSTITUTIONAL_FLOOR.prohibitedPrimitives entry as prohibited, even with empty config", () => {
    const k = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    for (const prim of CONSTITUTIONAL_FLOOR.prohibitedPrimitives) {
      expect(k.classify({ actionType: prim, origin: "x", sessionId: "s", payload: null }), prim).toBe("prohibited");
    }
  });
});
