import { describe, it, expect } from "vitest";
import { createSecurityKernel } from "./index.js";

// Drift D6: the operator `requireGrant` policy list must actually change
// classification — editing it was previously cosmetic (classify ignored it).
describe("classify — operator-tightened consequentialActions gate", () => {
  const fresh = () =>
    createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });

  it("a custom action is benign until added to consequentialActions, then gates", () => {
    const k = fresh();
    const req = { actionType: "approve_invoice", origin: "x", sessionId: "s", payload: null };
    expect(k.classify(req)).toBe("benign");

    k.applyPolicy({ consequentialActions: ["approve_invoice"] });
    expect(k.classify(req)).toBe("consequential");
  });

  it("built-in consequential defaults still gate regardless of the operator list", () => {
    const k = fresh();
    expect(k.classify({ actionType: "submit", origin: "x", sessionId: "s", payload: null })).toBe("consequential");
  });

  it("matches by prefix, like the built-in sets", () => {
    const k = fresh();
    k.applyPolicy({ consequentialActions: ["wire."] });
    expect(k.classify({ actionType: "wire.transfer", origin: "x", sessionId: "s", payload: null })).toBe("consequential");
  });

  it("the prohibited floor still outranks an operator consequential entry", () => {
    const k = fresh();
    k.applyPolicy({ consequentialActions: ["payment"] }); // payment is a floor primitive
    expect(k.classify({ actionType: "payment", origin: "x", sessionId: "s", payload: null })).toBe("prohibited");
  });
});
