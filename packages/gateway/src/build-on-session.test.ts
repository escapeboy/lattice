/**
 * BuildOnSession (ADR 0002) — the four build-on layers composed into one
 * governed session. Unit tests use a fake engine; the live test (opt-in) drives
 * real agent-browser end-to-end, proving the agent reaches the engine ONLY
 * through the governed Lattice path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BuildOnSession } from "./build-on-session.js";
import { createSecurityKernel } from "@lattice/kernel";
import { AgentBrowserEngine } from "@lattice/engine-adapter";
import type {
  EngineSession,
  NavResult,
  RawSnapshot,
  SemanticAction,
  ActionResult,
} from "@lattice/engine-adapter";

const ORIGIN = "https://app.example.com";

class FakeEngine implements EngineSession {
  readonly id = "lattice-fake" as EngineSession["id"];
  acts: SemanticAction[] = [];
  tree = '- button "Submit" [ref=e1]\n- textbox "Email" [ref=e2]';

  navigate(url: string): Promise<NavResult> {
    return Promise.resolve({ url, title: "" });
  }
  currentUrl(): Promise<string> {
    return Promise.resolve(`${ORIGIN}/`);
  }
  snapshot(): Promise<RawSnapshot> {
    return Promise.resolve({ url: `${ORIGIN}/`, refs: [], tree: this.tree });
  }
  readText(): Promise<string> {
    return Promise.resolve("text");
  }
  screenshot(): Promise<string> {
    return Promise.resolve("BASE64PNG");
  }
  act(action: SemanticAction): Promise<ActionResult> {
    this.acts.push(action);
    return Promise.resolve({ ok: true, url: `${ORIGIN}/`, error: undefined });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function kernel() {
  return createSecurityKernel({
    allowedOrigins: [ORIGIN],
    egressAllowlist: [],
    prohibitedActions: [],
  });
}

describe("BuildOnSession — governed composition (unit)", () => {
  it("perceives a taint-marked IG and re-anchors NodeId → ref for actions", async () => {
    const engine = new FakeEngine();
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s1" });

    const ig = await session.perceive();
    expect(ig.graph.nodes.size).toBe(2);
    for (const id of ig.graph.nodes.keys()) {
      expect(ig.taint.get(id)?.origin).toBe("page-content");
    }

    const emailId = [...ig.graph.nodes.values()].find((n) => n.role === "input")!.id;
    await session.act({ type: "fill", target: { nodeId: emailId }, value: "ada@x.com" });
    // The stable NodeId resolved to the engine's current ref e2.
    expect(engine.acts.at(-1)).toEqual({
      type: "fill",
      target: { kind: "ref", ref: "e2" },
      value: "ada@x.com",
    });
  });

  it("re-anchors to the NEW ref after a re-render (identity stable, ref changed)", async () => {
    const engine = new FakeEngine();
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s1" });
    const ig1 = await session.perceive();
    const submitId = [...ig1.graph.nodes.values()].find((n) => n.role === "button")!.id;

    // Page re-renders: same elements, different refs.
    engine.tree = '- button "Submit" [ref=e8]\n- textbox "Email" [ref=e9]';
    const ig2 = await session.perceive();
    // Same stable id is present in the new snapshot…
    expect(ig2.graph.nodes.has(submitId)).toBe(true);
    // …and an action now resolves it to the NEW ref.
    await session.act({ type: "act", target: { nodeId: submitId } });
    expect(engine.acts.at(-1)).toEqual({ type: "click", target: { kind: "ref", ref: "e8" } });
  });

  it("an empty delta results when only refs churned between perceives", async () => {
    const engine = new FakeEngine();
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s1" });
    const a = await session.perceive();
    engine.tree = '- button "Submit" [ref=e8]\n- textbox "Email" [ref=e9]';
    const b = await session.perceive();
    const d = session.delta(a, b);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.updated).toHaveLength(0);
  });

  it("consequential submit without a human grant is blocked — engine untouched", async () => {
    const engine = new FakeEngine();
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s1" });
    const ig = await session.perceive();
    const realId = [...ig.graph.nodes.values()].find((n) => n.role === "button")!.id;
    await expect(session.act({ type: "submit", target: { nodeId: realId } })).rejects.toThrow();
    expect(engine.acts).toHaveLength(0);
  });
});

// ── Live end-to-end over real agent-browser (opt-in) ─────────────────────────

const live = process.env["LATTICE_LIVE_ENGINE"] === "1" ? describe : describe.skip;

live("BuildOnSession — governed end-to-end over real agent-browser (S4/S6)", () => {
  const engine = new AgentBrowserEngine({ timeoutMs: 60_000 });
  const PAGE = "data:text/html,<form><input aria-label=Email><button>Submit</button></form>";
  let session: BuildOnSession;

  beforeAll(async () => {
    await engine.launch();
    const es = await engine.createSession();
    // data: URLs are always in-scope; the agent never touches `es` directly —
    // only this governed session does.
    const k = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    session = new BuildOnSession(es, k, { origin: "data:", sessionId: "live" });
  }, 90_000);

  afterAll(async () => {
    await engine.shutdown().catch(() => undefined);
  });

  it("navigate → perceive (stable ids + taint) → governed fill + click", async () => {
    await session.act({ type: "navigate", url: PAGE });
    const ig = await session.perceive();
    const roles = [...ig.graph.nodes.values()].map((n) => n.role);
    expect(roles).toContain("button");
    expect(roles).toContain("input");
    for (const id of ig.graph.nodes.keys()) expect(ig.taint.get(id)?.origin).toBe("page-content");

    const emailId = [...ig.graph.nodes.values()].find((n) => n.role === "input")!.id;
    const fill = await session.act({ type: "fill", target: { nodeId: emailId }, value: "ada@x.com" });
    expect(fill.ok).toBe(true);

    const buttonId = [...ig.graph.nodes.values()].find((n) => n.role === "button")!.id;
    const click = await session.act({ type: "act", target: { nodeId: buttonId } });
    expect(click.ok).toBe(true);
  });
});

describe("BuildOnSession — bounded failure recovery (P2.1)", () => {
  it("re-anchors a target whose surrounding restructured, via the alt-locator rung", async () => {
    const engine = new FakeEngine();
    engine.tree = '- list "Items" [ref=e1]\n  - button "Save" [ref=e2]';
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s1" });

    const ig = await session.perceive();
    const save = [...ig.graph.nodes.values()].find((n) => n.label === "Save")!;

    // The page restructures: Save is wrapped in a new listitem → its stable id
    // changes, but role+label persist. Re-anchor (rung 1) misses; the alt-locator
    // (rung 2) finds it.
    engine.tree = '- list "Items" [ref=e1]\n  - listitem "Row" [ref=e2]\n    - button "Save" [ref=e3]';
    const result = await session.recover({ nodeId: save.id, role: save.role, label: save.label }, "element_gone");
    expect(result.outcome).toBe("resolved");
    expect(result.rung).toBe("alt_locator");
  });

  it("hands off (once, bounded) when the target is gone and no escalation sees it", async () => {
    const engine = new FakeEngine();
    engine.tree = '- list "Items" [ref=e1]\n  - button "Save" [ref=e2]';
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s2" });
    const ig = await session.perceive();
    const save = [...ig.graph.nodes.values()].find((n) => n.label === "Save")!;

    engine.tree = '- list "Items" [ref=e1]\n  - button "Cancel" [ref=e2]'; // Save gone
    let handoffs = 0;
    const result = await session.recover(
      { nodeId: save.id, role: save.role, label: save.label },
      "element_gone",
      { handoff: () => { handoffs++; return Promise.resolve(); } },
    );
    expect(result.outcome).toBe("handoff");
    expect(handoffs).toBe(1);
  });
});
