import { describe, it, expect } from "vitest";
import { createSecurityKernel } from "./index.js";

// A4: egress decision consults provenance; content-proposed off-origin exfil is
// blocked, while a legitimate same-origin form posts through.
describe("checkEgress — provenance-aware (A4)", () => {
  const k = createSecurityKernel({
    allowedOrigins: ["https://app.example.com"],
    egressAllowlist: ["https://app.example.com"],
    prohibitedActions: [],
  });
  const base = { taskOrigin: "https://app.example.com", sessionId: "s1" };

  it("blocks a destination PROPOSED BY PAGE CONTENT to an off-origin exfil target", () => {
    expect(k.checkEgress({ ...base, destination: "https://attacker.example/collect?d=secret", sourceOrigin: "page-content" })).toBe(false);
  });
  it("allows a legitimate same-origin form submit (even when page-sourced)", () => {
    expect(k.checkEgress({ ...base, destination: "https://app.example.com/login", sourceOrigin: "page-content" })).toBe(true);
  });
  it("allows an explicitly allowlisted cross-origin destination", () => {
    const k2 = createSecurityKernel({ allowedOrigins: ["https://app.example.com"], egressAllowlist: ["https://api.partner.com"], prohibitedActions: [] });
    expect(k2.checkEgress({ ...base, destination: "https://api.partner.com/v1", sourceOrigin: "task" })).toBe(true);
  });
});
