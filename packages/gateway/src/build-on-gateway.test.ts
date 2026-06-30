/**
 * S6 serve flip (ADR 0002): an external MCP client drives the gateway end-to-end
 * over the BUILD-ON stack (agent-browser behind the governed session) instead of
 * CDP. Same MCP surface, different engine. Proves the Definition-of-Done
 * invariant: the agent reaches the engine ONLY through the gateway, and no tool
 * exposes a raw-CDP/eval path.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSecurityKernel } from "@lattice/kernel";
import { AgentBrowserEngine } from "@lattice/engine-adapter";
import { createBuildOnGateway } from "./index.js";
import type {
  SemanticEngine,
  EngineSession,
  NavResult,
  RawSnapshot,
  SemanticAction,
  ActionResult,
} from "@lattice/engine-adapter";

type MCPContent = { type: string; text: string };
function toolText(res: { [x: string]: unknown }): string {
  const item = (res as { content: unknown[] }).content[0] as MCPContent | undefined;
  if (!item || item.type !== "text") throw new Error("Expected text content");
  return item.text;
}
function toolJson(res: { [x: string]: unknown }): Record<string, unknown> {
  return JSON.parse(toolText(res)) as Record<string, unknown>;
}

class FakeEngine implements SemanticEngine, EngineSession {
  readonly id = "lattice-fake" as EngineSession["id"];
  launched = false;
  // 3 addressable nodes → a NORMAL page (above the contentSparse ≤2 threshold),
  // so the normal perceive path (no auto-L3) is what the baseline tests exercise.
  tree = '- link "Home" [ref=e3]\n- button "Submit" [ref=e1]\n- textbox "Email" [ref=e2]';
  acts: SemanticAction[] = [];
  /** Override per test to simulate a non-quiescing navigation (settled:false). */
  nextNavSettled: boolean | undefined;
  screenshotCalls = 0;

  // SemanticEngine
  launch(): Promise<void> {
    this.launched = true;
    return Promise.resolve();
  }
  createSession(): Promise<EngineSession> {
    return Promise.resolve(this);
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  // EngineSession
  navigate(url: string): Promise<NavResult> {
    return Promise.resolve({ url, title: "", ...(this.nextNavSettled !== undefined ? { settled: this.nextNavSettled } : {}) });
  }
  currentUrl(): Promise<string> {
    return Promise.resolve("https://app.example.com/");
  }
  snapshot(): Promise<RawSnapshot> {
    return Promise.resolve({ url: "https://app.example.com/", refs: [], tree: this.tree });
  }
  readText(): Promise<string> {
    return Promise.resolve("page text");
  }
  screenshot(): Promise<string> {
    this.screenshotCalls += 1;
    // Valid base64 (the MCP SDK validates image content data on the wire).
    return Promise.resolve(Buffer.from("fake-png-bytes").toString("base64"));
  }
  act(action: SemanticAction): Promise<ActionResult> {
    this.acts.push(action);
    return Promise.resolve({ ok: true, url: "https://app.example.com/x", error: undefined });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function build() {
  const engine = new FakeEngine();
  await engine.launch();
  const kernel = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
  const gateway = createBuildOnGateway({ engine, kernel });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.getMCPServer().connect(st);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(ct);
  return { engine, gateway, client };
}

describe("build-on gateway — external MCP client drives the build-on stack (S6)", () => {
  it("perceive → act run over agent-browser through the governed session", async () => {
    const { engine, client, gateway } = await build();

    const created = toolJson(await client.callTool({ name: "session_create", arguments: {} }));
    const sessionId = created["sessionId"] as string;
    expect(sessionId).toBeTruthy();

    const snap = toolJson(await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } }));
    const nodes = snap["nodes"] as Array<{ role: string; id: string }>;
    expect(nodes.map((n) => n.role)).toContain("button");
    expect(nodes.map((n) => n.role)).toContain("input");

    // Act by stable NodeId — the gateway re-anchors it to the engine's ref.
    const buttonId = nodes.find((n) => n.role === "button")!.id;
    const res = toolJson(
      await client.callTool({ name: "act_execute", arguments: { sessionId, command: { type: "act", target: { nodeId: buttonId } } } }),
    );
    expect(res["success"]).toBe(true);
    expect(engine.acts.at(-1)).toMatchObject({ type: "click" });

    await client.close();
    await gateway.stop();
  });

  it("no agent tool exposes raw CDP / eval — capability_check degrades to no-fastpath", async () => {
    const { client, gateway } = await build();
    const created = toolJson(await client.callTool({ name: "session_create", arguments: {} }));
    const sessionId = created["sessionId"] as string;

    // The WebMCP probe would need eval/CDP — firewalled on build-on, so it must
    // degrade to "no native MCP" rather than expose a CDP path.
    const cap = toolJson(await client.callTool({ name: "capability_check", arguments: { sessionId } }));
    expect(cap["nativeMCP"]).toBe(false);
    expect(cap["fastPath"]).toBe(false);

    // No tool named eval/cdp/connect exists on the agent surface.
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain("eval");
    expect(names).not.toContain("cdp");
    expect(names).not.toContain("connect");

    await client.close();
    await gateway.stop();
  });

  it("a consequential submit without a human grant is blocked over MCP", async () => {
    const { engine, client, gateway } = await build();
    const created = toolJson(await client.callTool({ name: "session_create", arguments: {} }));
    const sessionId = created["sessionId"] as string;
    const snap = toolJson(await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } }));
    const buttonId = (snap["nodes"] as Array<{ role: string; id: string }>).find((n) => n.role === "button")!.id;

    const res = await client.callTool({
      name: "act_execute",
      arguments: { sessionId, command: { type: "submit", target: { nodeId: buttonId } } },
    });
    // act_execute surfaces the kernel refusal as an error result.
    expect(JSON.stringify(res)).toMatch(/prohibit|grant|block|human/i);
    expect(engine.acts.filter((a) => a.type === "submit")).toHaveLength(0);

    await client.close();
    await gateway.stop();
  });
});

describe("build-on gateway — canvas / non-quiescing fallback (Stage A+B)", () => {
  type ContentItem = { type: string; data?: string; mimeType?: string; text?: string };
  const content = (res: { [x: string]: unknown }): ContentItem[] => (res as { content: ContentItem[] }).content;

  it("STAGE B: a canvas/sparse page auto-escalates to L3 — screenshot + minimal IG, never empty", async () => {
    const { engine, client, gateway } = await build();
    engine.tree = '- img "WebGL aquarium" [ref=e1]'; // 1 node → contentSparse (the aquarium case)
    const { sessionId } = toolJson(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };

    // Agent asks for L1 (NOT L3) — the gateway escalates on its own because the
    // accessibility tree is blind.
    const res = await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } });
    const items = content(res);
    const text = items.find((i) => i.type === "text")!;
    const image = items.find((i) => i.type === "image");
    const payload = JSON.parse(text.text!) as Record<string, unknown>;

    expect(image).toBeTruthy();                       // a live screenshot is attached
    expect(image!.data).toBe(Buffer.from("fake-png-bytes").toString("base64"));
    expect(image!.mimeType).toBe("image/png");
    expect(engine.screenshotCalls).toBe(1);
    expect(payload["tier"]).toBe("L3");               // auto-escalated
    expect(payload["autoEscalatedToL3"]).toBeTruthy();
    expect((payload["signals"] as { contentSparse: boolean }).contentSparse).toBe(true);

    await client.close();
    await gateway.stop();
  });

  it("STAGE A+B: navigating to a non-quiescing canvas returns a LIVE result, no hang/throw, session stays usable", async () => {
    const { engine, client, gateway } = await build();
    engine.nextNavSettled = false;                    // bounded-settle adapter degraded the page
    engine.tree = '- img "WebGL aquarium" [ref=e1]';
    const { sessionId } = toolJson(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };

    // (A) Navigation succeeds (not-settled) — does NOT throw / hang.
    const nav = toolJson(await client.callTool({
      name: "act_execute",
      arguments: { sessionId, command: { type: "navigate", url: "https://webglsamples.org/aquarium/aquarium.html" } },
    }));
    expect(nav["success"]).toBe(true);
    expect(nav["settled"]).toBe(false);

    // (B) The follow-up perceive yields pixels — the case is captured.
    const res = await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } });
    expect(content(res).some((i) => i.type === "image")).toBe(true);

    // Session is still alive and usable afterward.
    const again = toolJson(await client.callTool({ name: "session_list", arguments: {} }));
    expect((again["sessions"] as string[])).toContain(sessionId);

    await client.close();
    await gateway.stop();
  });

  it("REGRESSION: a normal (non-sparse) page does NOT auto-escalate — no screenshot, plain L1", async () => {
    const { engine, client, gateway } = await build(); // default tree = 3 nodes (normal)
    const { sessionId } = toolJson(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };
    const res = await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } });
    const items = content(res);
    expect(items.some((i) => i.type === "image")).toBe(false);
    expect(engine.screenshotCalls).toBe(0);
    expect((JSON.parse(items[0]!.text!) as Record<string, unknown>)["tier"]).toBe("L1");

    await client.close();
    await gateway.stop();
  });
});

// ── Live: full production path MCP → gateway → build-on → real Chrome (opt-in) ─

const live = process.env["LATTICE_LIVE_ENGINE"] === "1" ? describe : describe.skip;

live("build-on gateway — LIVE over real agent-browser (S6 DoD)", () => {
  it("an MCP client drives navigate → perceive → act against real Chrome", async () => {
    const engine = new AgentBrowserEngine({ timeoutMs: 60_000 });
    await engine.launch();
    const kernel = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const gateway = createBuildOnGateway({ engine, kernel });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.getMCPServer().connect(st);
    const client = new Client({ name: "live", version: "0.0.1" });
    await client.connect(ct);
    try {
      const { sessionId } = toolJson(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };
      await client.callTool({
        name: "act_execute",
        arguments: { sessionId, command: { type: "navigate", url: "data:text/html,<form><input aria-label=Email><button>Go</button></form>" } },
      });
      const snap = toolJson(await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } }));
      const nodes = snap["nodes"] as Array<{ role: string; id: string }>;
      expect(nodes.map((n) => n.role)).toContain("button");

      const emailId = nodes.find((n) => n.role === "input")!.id;
      const fill = toolJson(await client.callTool({ name: "act_execute", arguments: { sessionId, command: { type: "fill", target: { nodeId: emailId }, value: "ada@x.com" } } }));
      expect(fill["success"]).toBe(true);
    } finally {
      await client.close();
      await gateway.stop();
      await engine.shutdown();
    }
  }, 90_000);
});
