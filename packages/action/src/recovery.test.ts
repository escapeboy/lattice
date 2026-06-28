import { describe, it, expect } from "vitest";
import { runLadder, locateInIG, RecoveryExecutor } from "./recovery.js";
import type { RecoveryTarget, LocatableNode, RecoveryDeps } from "./recovery.js";
import type { NodeId } from "@lattice/perception";

const target: RecoveryTarget = { nodeId: "button-x" as NodeId, role: "button", label: "Save" };

describe("runLadder — pure, single-pass decision", () => {
  it("rung 1: re-anchored stable ref wins", () => {
    expect(runLadder({ reanchorRef: "e3" })).toEqual({ outcome: "resolved", rung: "reanchor", ref: "e3" });
  });
  it("rung 2: alternative locator when the stable id is gone", () => {
    expect(runLadder({ altLocatorRef: "e7" })).toEqual({ outcome: "resolved", rung: "alt_locator", ref: "e7" });
  });
  it("rung 3: L3 vision when a11y identity is gone but it is on screen", () => {
    expect(runLadder({ l3Locatable: true })).toEqual({ outcome: "resolved", rung: "l3_vision" });
  });
  it("rung 4: handoff when nothing locates it", () => {
    expect(runLadder({})).toEqual({ outcome: "handoff", rung: "handoff" });
  });
  it("prefers the cheapest rung that resolves (reanchor over alt over l3)", () => {
    expect(runLadder({ reanchorRef: "e1", altLocatorRef: "e2", l3Locatable: true }).rung).toBe("reanchor");
    expect(runLadder({ altLocatorRef: "e2", l3Locatable: true }).rung).toBe("alt_locator");
  });
});

describe("locateInIG — re-anchor then role+attribute fallback", () => {
  const nodes: LocatableNode[] = [
    { id: "button-x" as NodeId, role: "button", label: "Save" },
    { id: "button-y" as NodeId, role: "button", label: "Cancel" },
  ];
  it("re-anchors by stable id when present", () => {
    const r = locateInIG(target, nodes, (id) => (id === ("button-x" as NodeId) ? "e1" : undefined));
    expect(r).toEqual({ reanchorRef: "e1" });
  });
  it("falls back to role+label when the stable id changed", () => {
    // The element was restructured: new id 'button-z', same role+label.
    const shifted: LocatableNode[] = [{ id: "button-z" as NodeId, role: "button", label: "Save" }];
    const r = locateInIG(target, shifted, (id) => (id === ("button-z" as NodeId) ? "e9" : undefined));
    expect(r).toEqual({ altLocatorRef: "e9" });
  });
  it("returns nothing when neither id nor attribute matches", () => {
    const gone: LocatableNode[] = [{ id: "button-q" as NodeId, role: "button", label: "Other" }];
    expect(locateInIG(target, gone, () => undefined)).toEqual({});
  });
  it("survives a route-change: relocates by tolerant role+label among an all-new subtree (smoke #6)", () => {
    // Hard SPA route change — the whole subtree is replaced. The control has a
    // brand-new id, sits among different siblings, and its label gained a
    // decorative glyph. rung-1 (stable id) misses; rung-2 must still find it via
    // the tolerant label match (so route-change recovery isn't only proven for a
    // simple re-render).
    const afterRoute: LocatableNode[] = [
      { id: "link-home" as NodeId, role: "link", label: "Home" },
      { id: "button-newid" as NodeId, role: "button", label: "Save →" },
      { id: "button-other" as NodeId, role: "button", label: "Discard" },
    ];
    const r = locateInIG(target, afterRoute, (id) => (id === ("button-newid" as NodeId) ? "e42" : undefined));
    expect(r).toEqual({ altLocatorRef: "e42" });
  });
});

describe("RecoveryExecutor — bounded async ladder (no blind retry)", () => {
  function deps(over: Partial<RecoveryDeps>): RecoveryDeps {
    return {
      relocate: () => Promise.resolve({}),
      l3Locate: () => Promise.resolve(false),
      handoff: () => Promise.resolve(),
      ...over,
    };
  }

  it("resolves at rung 1 without touching L3 or handoff", async () => {
    let l3 = 0;
    let ho = 0;
    const ex = new RecoveryExecutor(
      deps({
        relocate: () => Promise.resolve({ reanchorRef: "e1" }),
        l3Locate: () => { l3++; return Promise.resolve(true); },
        handoff: () => { ho++; return Promise.resolve(); },
      }),
    );
    const r = await ex.recover(target, "element_gone");
    expect(r).toEqual({ outcome: "resolved", rung: "reanchor", ref: "e1" });
    expect(l3).toBe(0);
    expect(ho).toBe(0);
  });

  it("escalates to L3 only when re-anchor and alt-locator both miss", async () => {
    const ex = new RecoveryExecutor(deps({ l3Locate: () => Promise.resolve(true) }));
    expect((await ex.recover(target, "obscured")).rung).toBe("l3_vision");
  });

  it("hands off (once) when every rung misses — terminal, not a loop", async () => {
    let ho = 0;
    const ex = new RecoveryExecutor(deps({ handoff: () => { ho++; return Promise.resolve(); } }));
    const r = await ex.recover(target, "element_gone");
    expect(r.outcome).toBe("handoff");
    expect(ho).toBe(1); // exactly one escalation, no retry storm
  });
});
