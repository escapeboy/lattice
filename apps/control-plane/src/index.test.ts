/**
 * S8 — Control Plane tests.
 * HTTP server + SSE + ApprovalInbox + PolicyEditor.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ControlPlaneServer } from "./server.js";
import { ApprovalInbox } from "./inbox.js";
import { PolicyEditor } from "./policy.js";
import type { PolicyConfig } from "./types.js";

// ── ApprovalInbox unit tests ─────────────────────────────────────────────────

describe("ApprovalInbox", () => {
  it("queues a grant request and resolves on approve", async () => {
    const inbox = new ApprovalInbox();

    const grantPromise = inbox.grantHandler({
      actionType: "submit",
      origin: "https://shop.example.com",
      sessionId: "sess-1",
      payload: null,
    });

    const pending = inbox.pendingList();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.actionType).toBe("submit");

    const decision = await inbox.approve(pending[0]!.id);
    expect(decision.outcome).toBe("approved");

    const grant = await grantPromise;
    expect(grant.granted).toBe(true);
  });

  it("deny resolves with granted=false and records the reason", async () => {
    const inbox = new ApprovalInbox();

    const grantPromise = inbox.grantHandler({
      actionType: "delete",
      origin: "https://admin.example.com",
      sessionId: "sess-2",
      payload: null,
    });

    const [pending] = inbox.pendingList();
    const decision = await inbox.deny(pending!.id, "too risky");
    expect(decision.outcome).toBe("denied");

    const grant = await grantPromise;
    expect(grant.granted).toBe(false);
    expect(grant.reason).toBe("too risky");
  });

  it("throws when approving an unknown ID", async () => {
    const inbox = new ApprovalInbox();
    await expect(inbox.approve("nonexistent")).rejects.toThrow("not found");
  });

  it("fires onRequest listener when a grant comes in", async () => {
    const inbox = new ApprovalInbox();
    const received: string[] = [];
    inbox.onRequest((r) => { received.push(r.actionType); });

    const p = inbox.grantHandler({ actionType: "checkout", origin: "https://x.com", sessionId: "s", payload: null });
    expect(received).toContain("checkout");

    const [first] = inbox.pendingList();
    await inbox.deny(first!.id);
    await p;
  });
});

// ── PolicyEditor unit tests ──────────────────────────────────────────────────

describe("PolicyEditor", () => {
  it("returns a copy of the default policy", () => {
    const pe = new PolicyEditor();
    const cfg = pe.get();
    expect(cfg.prohibitedActions).toContain("payment");
    expect(cfg.requireGrant).toContain("submit");
  });

  it("update merges a patch", () => {
    const pe = new PolicyEditor();
    pe.update({ allowedOrigins: ["https://trusted.com"] } satisfies Partial<PolicyConfig>);
    expect(pe.get().allowedOrigins).toContain("https://trusted.com");
    expect(pe.get().prohibitedActions.length).toBeGreaterThan(0);
  });

  it("toKernelConfig returns kernel-compatible shape", () => {
    const pe = new PolicyEditor({ egressAllowlist: ["https://cdn.example.com"] });
    const kc = pe.toKernelConfig();
    expect(kc).toHaveProperty("allowedOrigins");
    expect(kc).toHaveProperty("egressAllowlist");
    expect(kc).toHaveProperty("prohibitedActions");
    expect(kc.egressAllowlist).toContain("https://cdn.example.com");
  });
});

// ── ControlPlaneServer HTTP tests ────────────────────────────────────────────

describe("ControlPlaneServer — HTTP API", () => {
  let server: ControlPlaneServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new ControlPlaneServer({ allowedOrigins: ["https://example.com"] });
    const { url } = await server.start();
    baseUrl = url;
  });

  afterAll(async () => {
    await server.stop();
  });

  async function get(path: string): Promise<unknown> {
    const r = await fetch(baseUrl + path);
    return r.json();
  }

  it("GET / returns HTML with control plane UI", async () => {
    const r = await fetch(baseUrl + "/");
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Lattice Control Plane");
    expect(html).toContain("approval");
  });

  it("GET /sessions returns empty list initially", async () => {
    const data = await get("/sessions") as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(0);
  });

  it("GET /approvals returns empty list initially", async () => {
    const data = await get("/approvals") as { approvals: unknown[] };
    expect(data.approvals).toHaveLength(0);
  });

  it("GET /policy returns policy config", async () => {
    const data = await get("/policy") as PolicyConfig;
    expect(data.prohibitedActions).toBeInstanceOf(Array);
    expect(data.allowedOrigins).toContain("https://example.com");
  });

  it("PUT /policy updates the policy", async () => {
    const r = await fetch(baseUrl + "/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ egressAllowlist: ["https://api.safe.com"] }),
    });
    const updated = await r.json() as PolicyConfig;
    expect(updated.egressAllowlist).toContain("https://api.safe.com");
  });

  it("full approval flow via HTTP: queue → approve via API", async () => {
    // Queue a grant request via the inbox
    const grantPromise = server.inbox.grantHandler({
      actionType: "checkout",
      origin: "https://shop.example.com",
      sessionId: "sess-http",
      payload: null,
    });

    // Check inbox via HTTP
    const approvalsRes = await get("/approvals") as { approvals: Array<{ id: string; actionType: string }> };
    expect(approvalsRes.approvals).toHaveLength(1);
    expect(approvalsRes.approvals[0]!.actionType).toBe("checkout");

    const approvalId = approvalsRes.approvals[0]!.id;

    // Approve via HTTP
    const r = await fetch(baseUrl + `/approvals/${approvalId}/approve`, { method: "POST" });
    const decision = await r.json() as { outcome: string };
    expect(decision.outcome).toBe("approved");

    // The grantHandler promise should now be resolved
    const grant = await grantPromise;
    expect(grant.granted).toBe(true);

    // Inbox should be empty now
    const afterApproval = await get("/approvals") as { approvals: unknown[] };
    expect(afterApproval.approvals).toHaveLength(0);
  });

  it("deny flow via HTTP: queue → deny with reason", async () => {
    const grantPromise = server.inbox.grantHandler({
      actionType: "delete",
      origin: "https://admin.example.com",
      sessionId: "sess-deny",
      payload: null,
    });

    const approvalsRes = await get("/approvals") as { approvals: Array<{ id: string }> };
    const approvalId = approvalsRes.approvals[0]!.id;

    const r = await fetch(baseUrl + `/approvals/${approvalId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "too dangerous" }),
    });
    const decision = await r.json() as { outcome: string };
    expect(decision.outcome).toBe("denied");

    const grant = await grantPromise;
    expect(grant.granted).toBe(false);
  });

  it("updateSession registers in theater, removeSession cleans up", async () => {
    server.updateSession({
      sessionId: "sess-theater",
      url: "https://example.com",
      nodeCount: 5,
      actionCount: 2,
    });

    const data = await get("/sessions") as { sessions: Array<{ sessionId: string }> };
    expect(data.sessions.some((s) => s.sessionId === "sess-theater")).toBe(true);

    server.removeSession("sess-theater");
    const after = await get("/sessions") as { sessions: Array<{ sessionId: string }> };
    expect(after.sessions.some((s) => s.sessionId === "sess-theater")).toBe(false);
  });

  it("POST /traces + GET /traces returns trace metrics", async () => {
    const mockTrace = {
      traceId: "trace-001",
      sessionId: "sess-001",
      startTs: Date.now() - 1000,
      endTs: Date.now(),
      events: [
        { kind: "session_start", traceId: "trace-001", sessionId: "sess-001", ts: Date.now() - 1000, seq: 0, topology: "ephemeral" },
        { kind: "metrics", traceId: "trace-001", sessionId: "sess-001", ts: Date.now(), seq: 1, totalActions: 3, successCount: 3, successRate: 1, tierDistribution: { L1: 2 }, durationMs: 1000 },
        { kind: "session_end", traceId: "trace-001", sessionId: "sess-001", ts: Date.now(), seq: 2, durationMs: 1000 },
      ],
    };

    const post = await fetch(baseUrl + "/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mockTrace),
    });
    expect(post.ok).toBe(true);

    const traces = await get("/traces") as { traces: Array<{ traceId: string; successRate: number }> };
    expect(traces.traces.some((t) => t.traceId === "trace-001")).toBe(true);
    expect(traces.traces.find((t) => t.traceId === "trace-001")!.successRate).toBe(1);
  });

  it("POST /intent returns queued=true", async () => {
    const r = await fetch(baseUrl + "/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "fill the login form" }),
    });
    const data = await r.json() as { queued: boolean; intent: string };
    expect(data.queued).toBe(true);
    expect(data.intent).toBe("fill the login form");
  });
});
