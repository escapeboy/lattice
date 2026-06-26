/**
 * @lattice/serve — unified core integration: one kernel, two faces.
 * Verifies the gateway (MCP) and control plane (HTTP) share grant/theater/handoff
 * state. The grant round-trip is browser-free; theater + handoff are browser-gated.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import { SecurityKernelImpl } from "@lattice/kernel";
import { createLatticeCore } from "./index.js";

function jsonOf(res: { [x: string]: unknown }): Record<string, unknown> {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function connectGatewayClient(core: ReturnType<typeof createLatticeCore>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await core.gateway.getMCPServer().connect(st);
  const client = new Client({ name: "serve-test", version: "0.0.1" });
  await client.connect(ct);
  return client;
}

describe("LatticeCore — UI and MCP share one grant slice", () => {
  it("agent write blocked → control plane raises it → approve mints a grant that the gateway accepts", async () => {
    const kernel = new SecurityKernelImpl({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const core = createLatticeCore({ engine: createEngineAdapter(), kernel });
    const { url } = await core.control.start(0, "127.0.0.1");
    const client = await connectGatewayClient(core);
    try {
      // 1. Agent attempts an operator write with no grant → blocked + raised to UI.
      const blocked = jsonOf(await client.callTool({ name: "budget_set", arguments: { limitTokens: 5000 } }));
      expect(blocked["status"]).toBe("awaiting_human_grant");

      // 2. The control plane shows the pending operator-grant request.
      const pending = await (await fetch(`${url}/operator-grants`)).json() as { grants: Array<{ id: string }> };
      expect(pending.grants.length).toBe(1);
      const reqId = pending.grants[0]!.id;

      // 3. Human approves in the UI → a token is minted on the SHARED kernel.
      const approved = await (await fetch(`${url}/operator-grants/${reqId}/approve`, { method: "POST" })).json() as { outcome: string; grant: string };
      expect(approved.outcome).toBe("approved");

      // 4. Agent retries with the token → the gateway (same kernel) accepts it.
      const applied = jsonOf(await client.callTool({ name: "budget_set", arguments: { grant: approved.grant, limitTokens: 5000 } }));
      expect(applied["status"]).toBe("applied");
      const budget = jsonOf(await client.callTool({ name: "budget_get", arguments: {} }));
      expect(budget["limitTokens"]).toBe(5000);
    } finally {
      await client.close();
      await core.gateway.stop();
      await core.control.stop();
    }
  });
});

describe("LatticeCore — human policy edit applies to the live kernel", () => {
  it("PUT /policy widens egress live and re-asserts the constitutional floor", async () => {
    const kernel = new SecurityKernelImpl({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const core = createLatticeCore({ engine: createEngineAdapter(), kernel });
    const { url } = await core.control.start(0, "127.0.0.1");
    try {
      // Human edits policy from the UI: widen egress, and try to drop the floor.
      const r = await fetch(url + "/policy", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ egressAllowlist: ["https://api.partner.com"], prohibitedActions: ["only.this"], budgetLimit: 1234 }),
      });
      expect(r.ok).toBe(true);

      // Live enforcement changed: partner origin now passes the egress firewall.
      expect(kernel.checkEgress({ destination: "https://api.partner.com/v1", sourceOrigin: "https://app", taskOrigin: "https://app", sessionId: "s1" })).toBe(true);
      // Floor re-asserted: payment stays prohibited despite the short list.
      expect(kernel.classify({ actionType: "payment", origin: "x", sessionId: "s1", payload: null })).toBe("prohibited");
      // The snapshot the UI reads reflects it.
      const pol = await (await fetch(url + "/policy")).json() as { egressAllowlist: string[]; prohibitedActions: string[] };
      expect(pol.egressAllowlist).toContain("https://api.partner.com");
      expect(pol.prohibitedActions).toContain("payment");
    } finally {
      await core.gateway.stop();
      await core.control.stop();
    }
  });
});

describe("LatticeCore — trace emission on teardown", () => {
  it("invokes the trace writer with a Svod path + metrics when a session ends", async () => {
    const exe = detectChromiumExecutable();
    if (!exe) return; // needs a real session to produce a trace
    const engine = createEngineAdapter();
    await engine.launch({ headless: true, executablePath: exe });
    const kernel = new SecurityKernelImpl({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const writes: Array<{ path: string; content: string }> = [];
    const core = createLatticeCore({ engine, kernel, traceWriter: (path, content) => { writes.push({ path, content }); return Promise.resolve(); } });
    const client = await connectGatewayClient(core);
    try {
      const { sessionId } = jsonOf(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };
      await client.callTool({ name: "act_execute", arguments: { sessionId, command: { type: "navigate", url: "data:text/html,<h1>t</h1>" } } });
      await client.callTool({ name: "session_destroy", arguments: { sessionId } });
      // emit is fire-and-forget; let the microtask flush.
      await new Promise((r) => setTimeout(r, 20));
      expect(writes.length).toBe(1);
      expect(writes[0]!.path).toContain("traces/");
      expect(writes[0]!.content).toContain("Metrics");
    } finally {
      await client.close();
      await core.gateway.stop();
      await engine.shutdown();
    }
  });
});

const exe = detectChromiumExecutable();
const describeIfBrowser = exe ? describe : describe.skip;

describeIfBrowser("LatticeCore — live theater + handoff (browser)", () => {
  it("a session appears in the theater; a handoff is resolvable from the control plane", async () => {
    const engine = createEngineAdapter();
    await engine.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    const kernel = new SecurityKernelImpl({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const core = createLatticeCore({ engine, kernel, handoffSigningKey: "serve-test-key" });
    const { url } = await core.control.start(0, "127.0.0.1");
    const client = await connectGatewayClient(core);
    try {
      const { sessionId } = jsonOf(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };

      // Live theater is populated via the gateway observer.
      const theater = await (await fetch(`${url}/sessions`)).json() as { sessions: Array<{ sessionId: string }> };
      expect(theater.sessions.some((s) => s.sessionId === sessionId)).toBe(true);

      // Register a device so the handoff fans out, then raise one.
      const grant = core.gateway.mintOperatorGrant({ tool: "device_register", sessionId: "operator" });
      await client.callTool({ name: "device_register", arguments: { grant, label: "Phone", channel: "ntfy", target: "topic" } });
      const raised = jsonOf(await client.callTool({ name: "session_handoff", arguments: { sessionId, type: "approval", reason: "2FA" } }));
      const handoffId = raised["handoffId"] as string;

      // The control plane lists it and serves the (signature-verified) page.
      const list = await (await fetch(`${url}/handoffs`)).json() as { handoffs: Array<{ id: string }> };
      expect(list.handoffs.some((h) => h.id === handoffId)).toBe(true);
      const page = await fetch(`${url}/handoff/${handoffId}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("verified");

      // Human approves from the control plane → the agent sees it approved.
      await fetch(`${url}/handoff/${handoffId}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: "web" }) });
      await fetch(`${url}/handoff/${handoffId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: "web", approved: true }) });
      const status = jsonOf(await client.callTool({ name: "handoff_status", arguments: { handoffId } }));
      expect(status["status"]).toBe("approved");

      await client.callTool({ name: "session_destroy", arguments: { sessionId } });
      // Session left the theater.
      const after = await (await fetch(`${url}/sessions`)).json() as { sessions: Array<{ sessionId: string }> };
      expect(after.sessions.some((s) => s.sessionId === sessionId)).toBe(false);
    } finally {
      await client.close();
      await core.gateway.stop();
      await core.control.stop();
      await engine.shutdown();
    }
  });
});
