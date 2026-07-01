/**
 * BuildOnSession (ADR 0002) — the four build-on layers composed into one
 * governed session. Unit tests use a fake engine; the live test (opt-in) drives
 * real agent-browser end-to-end, proving the agent reaches the engine ONLY
 * through the governed Lattice path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BuildOnSession } from "./build-on-session.js";
import { PerceptionCache } from "@lattice/perception";
import { createSecurityKernel } from "@lattice/kernel";
import type { CapabilityRequest, GrantDecision } from "@lattice/kernel";
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

  it("enriches the grant with a human action, masked field preview, target label, and intent", async () => {
    const engine = new FakeEngine();
    engine.tree = '- button "Log in" [ref=e1]\n- textbox "Email" [ref=e2]\n- textbox "Password" [ref=e3]';
    let captured: CapabilityRequest | undefined;
    const k = createSecurityKernel({
      allowedOrigins: [ORIGIN],
      egressAllowlist: [],
      prohibitedActions: [],
      grantHandler: (req): Promise<GrantDecision> => {
        captured = req;
        return Promise.resolve({ granted: true, grantId: "g1" });
      },
    });
    const session = new BuildOnSession(engine, k, { origin: ORIGIN, sessionId: "s1" });
    const nodes = [...(await session.perceive()).graph.nodes.values()];
    const byLabel = (l: string) => nodes.find((n) => n.label === l)!.id;

    await session.act({ type: "fill", target: { nodeId: byLabel("Email") }, value: "ada@x.com" });
    await session.act({ type: "fill", target: { nodeId: byLabel("Password") }, value: "hunter2" });
    await session.act({ type: "submit", target: { nodeId: byLabel("Log in") }, intent: "Log in as the test user" });

    expect(captured?.actionType).toBe("submit");
    expect(captured?.detail?.action).toBe("Submit form (2 fields)");
    // The live page origin is carried even though the session task scope is empty.
    expect(captured?.detail?.origin).toBe(ORIGIN);
    expect(captured?.detail?.targetLabel).toBe("Log in");
    expect(captured?.detail?.intent).toBe("Log in as the test user");
    // The password value is MASKED — the preview never carries the secret.
    expect(captured?.detail?.fields).toEqual([
      { label: "Email", value: "ada@x.com", masked: false },
      { label: "Password", value: "••••", masked: true },
    ]);
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

  it("EFFECT-GATE (live): click on an EXPLICIT submit control is gated; a bare <button> default-submit is NOT (residual)", async () => {
    // Recording DENY handler: a gated click is blocked (no navigation) and we can
    // read WHICH actionType the kernel classified. Exercises the REAL `get attr`
    // probe against the agent-browser binary — validates the envelope parse too.
    const calls: string[] = [];
    const k = createSecurityKernel({
      allowedOrigins: [],
      egressAllowlist: [],
      prohibitedActions: [],
      grantHandler: (req): Promise<GrantDecision> => {
        calls.push(req.actionType);
        return Promise.resolve({ granted: false, reason: "test-deny" });
      },
    });
    const es = await engine.createSession();
    const s = new BuildOnSession(es, k, { origin: "data:", sessionId: "live-gate" });

    // 1) <input type=submit>: clicking via `act` must reclassify to `submit` →
    //    the grant handler fires (hole A closed). Denied → the click is blocked.
    await s.act({ type: "navigate", url: "data:text/html,<form><input aria-label=User><input type=submit value=Login></form>" });
    const ig1 = await s.perceive();
    const submitId = [...ig1.graph.nodes.values()].find((n) => n.role === "button")!.id;
    await expect(s.act({ type: "act", target: { nodeId: submitId } })).rejects.toThrow();
    expect(calls).toEqual(["submit"]); // effect-gate fired: the click was classified as submit

    // 2) Bare <button> (no type attr = DEFAULT submit): clicking it is benign
    //    today — NO grant fires. This is the documented residual.
    await s.act({ type: "navigate", url: "data:text/html,<form><input aria-label=Note><button>Save</button></form>" });
    const ig2 = await s.perceive();
    const bareId = [...ig2.graph.nodes.values()].find((n) => n.role === "button")!.id;
    const res = await s.act({ type: "act", target: { nodeId: bareId } });
    expect(res.ok).toBe(true); // executed with no gate
    expect(calls).toEqual(["submit"]); // unchanged — the bare button did NOT trigger a grant

    await es.close().catch(() => undefined);
  }, 60_000);
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

describe("BuildOnSession — per-origin perception cache (P2.2)", () => {
  it("a warm revisit reuses the cached skeleton (cacheResolution shows nothing new)", async () => {
    const engine = new FakeEngine();
    engine.tree = '- list "Items" [ref=e1]\n  - button "Save" [ref=e2]';
    const cache = new PerceptionCache();
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s1", cache });

    const cold = (await session.perceive(), session.cacheResolution!);
    expect(cold.warm).toBe(false);
    expect(cold.sentNodes.length).toBeGreaterThan(0); // cold pays the skeleton

    // Same page again (a revisit, identical state).
    await session.perceive();
    const warm = session.cacheResolution!;
    expect(warm.warm).toBe(true);
    expect(warm.sentNodes.length).toBe(0); // nothing re-sent
  });

  it("the cache stays out of the way when not wired (cacheResolution undefined)", async () => {
    const engine = new FakeEngine();
    const session = new BuildOnSession(engine, kernel(), { origin: ORIGIN, sessionId: "s2" });
    await session.perceive();
    expect(session.cacheResolution).toBeUndefined();
  });
});
