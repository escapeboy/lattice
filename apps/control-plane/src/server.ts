/**
 * ControlPlaneServer — HTTP + SSE server for the human supervision UI.
 *
 * Routes:
 *   GET  /                       — HTML UI
 *   GET  /sessions               — JSON: active session views
 *   GET  /approvals              — JSON: pending approvals
 *   POST /approvals/:id/approve  — approve a pending grant
 *   POST /approvals/:id/deny     — deny with reason
 *   GET  /policy                 — JSON: current policy config
 *   PUT  /policy                 — update policy (JSON patch)
 *   GET  /traces                 — JSON: recent trace metrics
 *   POST /traces                 — submit a completed trace
 *   POST /intent                 — queue an intent (no-op for P0; hooks in S9)
 *   GET  /events                 — SSE stream for live updates
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { ApprovalInbox } from "./inbox.js";
import { PolicyEditor } from "./policy.js";
import { buildUI } from "./ui.js";
import type { PolicyConfig, SessionView } from "./types.js";
import type { SessionTrace } from "@lattice/observability";
import { extractMetrics } from "@lattice/observability";

interface TraceMetricsSummary {
  traceId: string;
  sessionId: string;
  durationMs: number;
  totalActions: number;
  successRate: number;
  recordedAt: number;
}

export class ControlPlaneServer {
  private server: Server | null = null;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly sessions = new Map<string, SessionView>();
  private readonly traces: TraceMetricsSummary[] = [];
  readonly inbox: ApprovalInbox;
  readonly policy: PolicyEditor;

  constructor(initial?: Partial<PolicyConfig>) {
    this.inbox = new ApprovalInbox();
    this.policy = new PolicyEditor(initial);

    // Forward approval queue changes to SSE clients
    this.inbox.onRequest(() => {
      this.broadcast({ type: "approvals", data: this.inbox.pendingList() });
    });
  }

  /** Register or update a live session view (called by gateway on snapshot). */
  updateSession(view: SessionView): void {
    this.sessions.set(view.sessionId, view);
    this.broadcast({ type: "sessions", data: Array.from(this.sessions.values()) });
  }

  /** Remove a session from the theater. */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.broadcast({ type: "sessions", data: Array.from(this.sessions.values()) });
  }

  /** Submit a completed trace for the replay browser. */
  submitTrace(trace: SessionTrace): void {
    const m = extractMetrics(trace);
    this.traces.unshift({
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      durationMs: m.durationMs,
      totalActions: m.totalActions,
      successRate: m.successRate,
      recordedAt: trace.endTs,
    });
    if (this.traces.length > 100) this.traces.length = 100;
    this.broadcast({ type: "trace", data: this.traces.slice(0, 10) });
  }

  start(port = 0, host = "127.0.0.1"): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((e: unknown) => {
          res.writeHead(500).end(String(e));
        });
      });
      this.server.listen(port, host, () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") { reject(new Error("bad address")); return; }
        resolve({ url: `http://${host}:${addr.port}` });
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.sseClients) client.end();
      this.sseClients.clear();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  address(): { port: number; host: string } | null {
    const addr = this.server?.address();
    if (!addr || typeof addr === "string") return null;
    return { port: addr.port, host: addr.address };
  }

  // ── HTTP routing ─────────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method?.toUpperCase() ?? "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (method === "GET" && path === "/") {
      const serverAddr = this.address();
      const origin = serverAddr ? `http://${serverAddr.host}:${serverAddr.port}` : "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(buildUI(origin));
      return;
    }

    if (method === "GET" && path === "/sessions") {
      json(res, { sessions: Array.from(this.sessions.values()) });
      return;
    }

    if (method === "GET" && path === "/approvals") {
      json(res, { approvals: this.inbox.pendingList() });
      return;
    }

    const approveMatch = path.match(/^\/approvals\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      const id = approveMatch[1]!;
      const decision = await this.inbox.approve(id).catch((e: unknown) => { throw e; });
      this.broadcast({ type: "approvals", data: this.inbox.pendingList() });
      json(res, decision);
      return;
    }

    const denyMatch = path.match(/^\/approvals\/([^/]+)\/deny$/);
    if (method === "POST" && denyMatch) {
      const id = denyMatch[1]!;
      const body = await readBody(req);
      const { reason } = (body ? JSON.parse(body) : {}) as { reason?: string };
      const decision = await this.inbox.deny(id, reason);
      this.broadcast({ type: "approvals", data: this.inbox.pendingList() });
      json(res, decision);
      return;
    }

    if (method === "GET" && path === "/policy") {
      json(res, this.policy.get());
      return;
    }

    if (method === "PUT" && path === "/policy") {
      const body = await readBody(req);
      if (!body) { res.writeHead(400).end("No body"); return; }
      const patch = JSON.parse(body) as Partial<PolicyConfig>;
      json(res, this.policy.update(patch));
      return;
    }

    if (method === "GET" && path === "/traces") {
      json(res, { traces: this.traces });
      return;
    }

    if (method === "POST" && path === "/traces") {
      const body = await readBody(req);
      if (!body) { res.writeHead(400).end("No body"); return; }
      const trace = JSON.parse(body) as SessionTrace;
      this.submitTrace(trace);
      json(res, { submitted: true });
      return;
    }

    if (method === "POST" && path === "/intent") {
      const body = await readBody(req);
      // P0: log intent; S9 will wire it to an agent
      const { intent } = (body ? JSON.parse(body) : {}) as { intent?: string };
      json(res, { queued: true, intent: intent ?? "" });
      return;
    }

    if (method === "GET" && path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("data: {\"type\":\"connected\"}\n\n");
      this.sseClients.add(res);
      req.on("close", () => { this.sseClients.delete(res); });
      return;
    }

    res.writeHead(404).end("Not found");
  }

  private broadcast(msg: unknown): void {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(data); } catch { this.sseClients.delete(client); }
    }
  }
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { chunks.push(c); });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : null));
    req.on("error", () => resolve(null));
  });
}
