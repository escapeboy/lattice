/**
 * S8.5 — human handoff: fan-out, first-claim-wins, signing, TTL fallback,
 * mediated-field (value never retained), and the end-to-end agent→human flow.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import { SecurityKernelImpl } from "@lattice/kernel";
import { HandoffManager, type NotificationTransport, type HandoffNotification } from "./handoff.js";
import type { DeviceRecord } from "./operator.js";
import { createAgentGateway } from "./index.js";
import type { GatewayServer } from "./server.js";

function device(id: string, target: string): DeviceRecord {
  return { id, label: id, channel: "ntfy", target, registeredAt: 0 };
}

class CollectingTransport implements NotificationTransport {
  readonly calls: Array<{ device: DeviceRecord; payload: HandoffNotification }> = [];
  notify(d: DeviceRecord, payload: HandoffNotification): Promise<void> {
    this.calls.push({ device: d, payload });
    return Promise.resolve();
  }
}

describe("HandoffManager — fan-out + claim", () => {
  it("notifies every registered device (notify everywhere)", async () => {
    const t = new CollectingTransport();
    const m = new HandoffManager(t, "key");
    await m.raise({ type: "approval", sessionId: "s1", origin: "https://x.com", reason: "confirm" }, [
      device("d1", "topic-a"),
      device("d2", "topic-b"),
      device("d3", "topic-c"),
    ]);
    expect(t.calls).toHaveLength(3);
    expect(t.calls.map((c) => c.device.id).sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("first claim wins; later claims are rejected (resolved elsewhere)", async () => {
    const m = new HandoffManager(new CollectingTransport(), "key");
    const req = await m.raise({ type: "approval", sessionId: "s1", origin: "o", reason: "r" }, [device("d1", "t1"), device("d2", "t2")]);
    expect(m.claim(req.id, "d1")).toBe(true);
    expect(m.claim(req.id, "d2")).toBe(false);
    expect(m.status(req.id)).toBe("claimed");
  });

  it("only the claiming device may resolve the approval", async () => {
    const m = new HandoffManager(new CollectingTransport(), "key");
    const req = await m.raise({ type: "approval", sessionId: "s1", origin: "o", reason: "r" }, [device("d1", "t1")]);
    m.claim(req.id, "d1");
    expect(m.resolveApproval(req.id, "d2", true)).toBe(false); // not the claimer
    expect(m.resolveApproval(req.id, "d1", true)).toBe(true);
    expect(m.status(req.id)).toBe("approved");
  });
});

describe("HandoffManager — signing", () => {
  it("a raised request carries a verifiable signature", async () => {
    const m = new HandoffManager(new CollectingTransport(), "secret-key");
    const req = await m.raise({ type: "input", sessionId: "s1", origin: "o", reason: "2FA", field: "otp" }, []);
    expect(m.verifySignature(req)).toBe(true);
  });

  it("a tampered request fails signature verification", async () => {
    const m = new HandoffManager(new CollectingTransport(), "secret-key");
    const req = await m.raise({ type: "input", sessionId: "s1", origin: "o", reason: "2FA", field: "otp" }, []);
    const forged = { ...req, field: "password" }; // attacker swaps the field
    expect(m.verifySignature(forged)).toBe(false);
  });
});

describe("HandoffManager — mediated input (value never retained)", () => {
  it("submitInput fills via the callback and never stores or logs the value", async () => {
    const m = new HandoffManager(new CollectingTransport(), "key");
    const req = await m.raise({ type: "input", sessionId: "s1", origin: "o", reason: "2FA", field: "otp" }, [device("d1", "t1")]);
    m.claim(req.id, "d1");

    let filled: string | undefined;
    const ok = await m.submitInput(req.id, "d1", "123456", (v) => { filled = v; return Promise.resolve(); });
    expect(ok).toBe(true);
    expect(filled).toBe("123456"); // value reached the form
    expect(m.status(req.id)).toBe("filled");

    // The secret value must NOT appear anywhere in the audit log.
    const auditJson = JSON.stringify(m.auditLog());
    expect(auditJson).not.toContain("123456");
  });

  it("input cannot be submitted by a non-claiming device", async () => {
    const m = new HandoffManager(new CollectingTransport(), "key");
    const req = await m.raise({ type: "input", sessionId: "s1", origin: "o", reason: "2FA", field: "otp" }, [device("d1", "t1")]);
    m.claim(req.id, "d1");
    const ok = await m.submitInput(req.id, "d2", "secret", () => Promise.resolve());
    expect(ok).toBe(false);
  });
});

describe("HandoffManager — TTL fallback", () => {
  it("a request past its TTL expires (default: pause + audit)", async () => {
    const m = new HandoffManager(new CollectingTransport(), "key", 5 * 60_000);
    const req = await m.raise({ type: "approval", sessionId: "s1", origin: "o", reason: "r", ttlMs: 1 }, [device("d1", "t1")]);
    await new Promise((r) => setTimeout(r, 5));
    expect(m.status(req.id)).toBe("expired");
    expect(m.claim(req.id, "d1")).toBe(false); // can't claim an expired handoff
    expect(m.auditLog().some((e) => e.kind === "expire")).toBe(true);
  });
});

// ── End-to-end via the MCP surface ────────────────────────────────────────────

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

describeIfBrowser("session_handoff — agent raises, human resolves (E2E)", () => {
  async function build(): Promise<{ client: Client; gateway: GatewayServer; transport: CollectingTransport; engine: ReturnType<typeof createEngineAdapter> }> {
    const engine = createEngineAdapter();
    await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const kernel = new SecurityKernelImpl({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const transport = new CollectingTransport();
    const gateway = createAgentGateway({ engine, kernel, handoffTransport: transport, handoffSigningKey: "test-key" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.getMCPServer().connect(st);
    const client = new Client({ name: "handoff-test", version: "0.0.1" });
    await client.connect(ct);
    return { client, gateway, transport, engine };
  }

  function jsonOf(res: { [x: string]: unknown }): Record<string, unknown> {
    const content = (res as { content: Array<{ type: string; text: string }> }).content;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it("registers a device, raises an approval handoff (fan-out), human two-taps approve", async () => {
    const { client, gateway, transport, engine } = await build();

    // Human registers a phone (control plane grant).
    const grant = gateway.mintOperatorGrant({ tool: "device_register", sessionId: "operator" });
    jsonOf(await client.callTool({ name: "device_register", arguments: { grant, label: "Phone", channel: "ntfy", target: "lattice-handoff" } }));

    // A browser session exists (data: URL — no external network).
    const { sessionId } = jsonOf(await client.callTool({ name: "session_create", arguments: {} })) as { sessionId: string };

    // Agent hits a 2FA wall and asks for human approval.
    const raised = jsonOf(await client.callTool({
      name: "session_handoff",
      arguments: { sessionId, type: "approval", reason: "Login requires 2FA confirmation" },
    }));
    const handoffId = raised["handoffId"] as string;
    expect(raised["status"]).toBe("pending");
    expect(raised["notifiedDevices"]).toBe(1);
    expect(transport.calls).toHaveLength(1); // fanned out to the phone

    // Agent polls — still pending.
    expect(jsonOf(await client.callTool({ name: "handoff_status", arguments: { handoffId } }))["status"]).toBe("pending");

    // Human claims from the phone and approves (two-tap) via the control-plane seam.
    const deviceId = gateway.handoffs.pending()[0]!.claimedBy ?? "phone";
    expect(gateway.handoffs.claim(handoffId, "phone")).toBe(true);
    void deviceId;
    expect(gateway.handoffs.resolveApproval(handoffId, "phone", true)).toBe(true);

    // Agent sees it approved.
    expect(jsonOf(await client.callTool({ name: "handoff_status", arguments: { handoffId } }))["status"]).toBe("approved");

    await client.callTool({ name: "session_destroy", arguments: { sessionId } });
    await client.close();
    await gateway.stop();
    await engine.shutdown();
  });
});
