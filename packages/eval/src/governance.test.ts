/**
 * Governance eval — asserts the differentiator gate, driven by the REAL kernel
 * and firewall (no mocks). The load-bearing claims:
 *   - Lattice blocks 100% of the corpus (step-4 stop condition is empty).
 *   - There exist attack classes only Lattice covers (the product differential).
 *   - The bare baseline blocks none of them.
 */

import { describe, it, expect } from "vitest";
import { ATTACKS, runGovernanceEval, formatGovernanceReport, wiredCountFor, DEPLOYMENT_DESKTOP } from "./governance.js";

describe("governance eval — real kernel/firewall adjudication", () => {
  it("the corpus spans multiple distinct attack classes", () => {
    const classes = new Set(ATTACKS.map((a) => a.cls));
    expect(classes.size).toBeGreaterThanOrEqual(6);
    expect(ATTACKS.length).toBeGreaterThanOrEqual(15);
  });

  it("LATTICE BLOCKS 100% of the corpus (step-4 gate)", () => {
    const r = runGovernanceEval();
    expect(r.latticeMisses).toEqual([]);
    expect(r.latticeBlocked).toBe(r.total);
  });

  it("there are classes only Lattice covers — even a hardened baseline misses them", () => {
    const r = runGovernanceEval();
    expect(r.uniqueToLattice.length).toBeGreaterThan(0);
    expect(r.uniqueToLattice).toContain("constitutional-floor");
    expect(r.uniqueToLattice).toContain("escape-hatch");
    expect(r.uniqueToLattice).toContain("injection-to-operator");
  });

  it("the bare baseline blocks nothing; Lattice strictly dominates the hardened one", () => {
    const r = runGovernanceEval();
    expect(r.bareBlocked).toBe(0);
    expect(r.latticeBlocked).toBeGreaterThan(r.hardenedBlocked);
  });

  it("each attack is adjudicated by code that actually returns a boolean verdict", () => {
    // Re-running an attack is deterministic and self-consistent.
    for (const a of ATTACKS) {
      expect(typeof a.latticeBlocks()).toBe("boolean");
      expect(a.latticeBlocks()).toBe(a.latticeBlocks());
    }
  });

  it("renders a report with the gate verdict and a totals row", () => {
    const text = formatGovernanceReport(runGovernanceEval());
    expect(text).toContain("GATE:");
    expect(text).toContain("TOTAL");
    expect(text).toContain("block rate");
  });

  it("DEFAULT-DEPLOYMENT view: honest wired count against `docker compose up` (18 zero-config, 20 configured of 22)", () => {
    const r = runGovernanceEval();
    expect(r.total).toBe(22);
    // The kernel blocks the whole corpus at the function level.
    expect(r.latticeBlocked).toBe(r.total);
    // Bare `docker compose up` (no allowlist → proxy off): all 4 egress-exfil unwired → 18/22.
    expect(r.wiredZeroConfig).toBe(18);
    expect([...r.unwiredZeroConfig].sort()).toEqual([
      "exfil-form-to-attacker-http", "exfil-form-to-attacker-https",
      "exfil-img-beacon-http", "exfil-img-beacon-https",
    ]);
    // Allowlist starts the proxy → HTTP egress wired, but HTTPS egress is NOT:
    // 20/22, NOT a full 22. This is the honest correction.
    expect(r.wiredConfigured).toBe(20);
    expect(r.wiredConfigured).not.toBe(r.total);
  });

  it("HONEST: HTTPS egress-exfil stays UNWIRED even with an allowlist (proxy gates HTTP only)", () => {
    const r = runGovernanceEval();
    // The two HTTPS vectors are blocked by checkEgress LOGIC but never reach the
    // real path — the proxy doesn't see HTTPS. This pin prevents regression to a
    // false "fully wired" claim until app-level HTTPS gating lands.
    expect([...r.unwiredHttpsEgress].sort()).toEqual([
      "exfil-form-to-attacker-https", "exfil-img-beacon-https",
    ]);
    expect(formatGovernanceReport(r)).toContain("HTTPS egress NOT wired");
  });

  it("escape-hatch wiring depends on build-on; egress on allowlist AND HTTP transport", () => {
    // 14 kernel + 4 escape-hatch + 2 HTTP egress-exfil = 20 (of 22). The 2 HTTPS
    // egress-exfil are never wired. cdp exposes eval/raw-CDP/file → escape-hatch unwired.
    expect(wiredCountFor({ engine: "cdp", egressAllowlistConfigured: false })).toBe(14);
    expect(wiredCountFor({ engine: "cdp", egressAllowlistConfigured: true })).toBe(16);
    expect(wiredCountFor({ engine: "build-on", egressAllowlistConfigured: false })).toBe(18);
    expect(wiredCountFor({ engine: "build-on", egressAllowlistConfigured: true })).toBe(20);
  });

  it("DESKTOP default (ADR 0003 D6): proxy ON via first-run allowlist → 20/22 (HTTP egress wired, HTTPS NOT)", () => {
    const r = runGovernanceEval();
    // The desktop ships the proxy ON (guided first-run allowlist), closing the
    // zero-config HTTP-egress hole. But the proxy gates HTTP only — the 2 HTTPS
    // egress-exfil vectors stay unwired. So 20/22, NOT a full 22/22.
    expect(wiredCountFor(DEPLOYMENT_DESKTOP)).toBe(20);
    expect(wiredCountFor(DEPLOYMENT_DESKTOP)).not.toBe(r.total);
  });
});
