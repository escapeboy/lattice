/**
 * Dual-stack adapter tests (ADR 0002, S6): the build-on stack satisfies the
 * gateway's PerceptionEngine / ActionEngine contracts, so server.ts can drive it
 * unchanged.
 */

import { describe, it, expect } from "vitest";
import { BuildOnSession } from "./build-on-session.js";
import { BuildOnPerceptionAdapter, BuildOnActionAdapter } from "./build-on-engine.js";
import { createSecurityKernel } from "@lattice/kernel";
import type { InteractionGraph, PerceptionEngine } from "@lattice/perception";
import type { ActionEngine } from "@lattice/action";
import type {
  EngineSession,
  NavResult,
  RawSnapshot,
  SemanticAction,
  ActionResult as EngineActionResult,
} from "@lattice/engine-adapter";

const ORIGIN = "https://app.example.com";

class FakeEngine implements EngineSession {
  readonly id = "lattice-fake" as EngineSession["id"];
  tree = '- button "Submit" [ref=e1]\n- textbox "Email" [ref=e2]';
  acts: SemanticAction[] = [];
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
    return Promise.resolve("page text");
  }
  screenshot(): Promise<string> {
    return Promise.resolve("BASE64PNG");
  }
  act(action: SemanticAction): Promise<EngineActionResult> {
    this.acts.push(action);
    return Promise.resolve({ ok: true, url: `${ORIGIN}/x`, error: undefined });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function build() {
  const engine = new FakeEngine();
  const kernel = createSecurityKernel({ allowedOrigins: [ORIGIN], egressAllowlist: [], prohibitedActions: [] });
  const session = new BuildOnSession(engine, kernel, { origin: ORIGIN, sessionId: "s1" });
  const perception = new BuildOnPerceptionAdapter(session);
  const action = new BuildOnActionAdapter(session, perception);
  return { engine, session, perception, action };
}

describe("BuildOnPerceptionAdapter — implements PerceptionEngine", () => {
  it("is assignable to PerceptionEngine (drop-in for the gateway)", () => {
    const { perception } = build();
    const asEngine: PerceptionEngine = perception;
    expect(typeof asEngine.snapshot).toBe("function");
    expect(typeof asEngine.delta).toBe("function");
  });

  it("L1 returns an InteractionGraph; L0 returns a structural summary", async () => {
    const { perception } = build();
    const l1 = (await perception.snapshot("L1")) as InteractionGraph;
    expect(l1.tier).toBe("L1");
    expect(l1.nodes.size).toBe(2);

    const l0 = await perception.snapshot("L0");
    expect(l0.tier).toBe("L0");
    if (l0.tier === "L0") expect(l0.interactiveCount).toBe(2);
  });

  it("delta of two graphs uses stable-id diffing", async () => {
    const { perception, engine } = build();
    const a = (await perception.snapshot("L1")) as InteractionGraph;
    engine.tree = '- button "Submit" [ref=e7]'; // Email removed; Submit ref churned
    const b = (await perception.snapshot("L1")) as InteractionGraph;
    const d = perception.delta(a, b);
    expect(d.removed).toHaveLength(1); // Email gone
    expect(d.added).toHaveLength(0); // Submit is the SAME stable id despite ref change
  });
});

describe("BuildOnActionAdapter — implements ActionEngine", () => {
  it("is assignable to ActionEngine (drop-in for the gateway)", () => {
    const { action } = build();
    const asEngine: ActionEngine = action;
    expect(typeof asEngine.execute).toBe("function");
  });

  it("execute returns ground-truth ActionResult with a delta and url", async () => {
    const { action, perception } = build();
    await perception.snapshot("L1"); // establish anchor
    const res = await action.execute({ type: "act", target: { nodeId: firstButtonId(await firstGraph(perception)) } });
    expect(res.success).toBe(true);
    expect(res.url).toContain(ORIGIN);
    expect(res.delta).toBeDefined();
  });

  it("a gated consequential action propagates the kernel refusal (engine contract)", async () => {
    const { action, perception } = build();
    const g = await firstGraph(perception);
    await expect(
      action.execute({ type: "submit", target: { nodeId: firstButtonId(g) } }),
    ).rejects.toThrow();
  });
});

async function firstGraph(p: BuildOnPerceptionAdapter): Promise<InteractionGraph> {
  return (await p.snapshot("L1")) as InteractionGraph;
}
function firstButtonId(g: InteractionGraph) {
  return [...g.nodes.values()].find((n) => n.role === "button")!.id;
}
