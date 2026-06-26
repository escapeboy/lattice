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
import { OperatorGrantInbox } from "./operator-grants.js";
import { buildUI } from "./ui.js";
import { buildHandoffPage } from "./handoff-page.js";
import { buildReplayPage, traceEventRows } from "./replay-page.js";
import type { ControlPlaneBackend, PolicyConfig, SessionView } from "./types.js";
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
  /**
   * Full, un-redacted traces for the operator's replay viewer.
   *
   * RETENTION (GDPR): in-memory ONLY — never written to disk or a DB, lost on
   * process restart — and ring-buffered to the most recent 50 (oldest evicted).
   * The only DURABLE trace sink is Svod, which is PII-redacted at emit (P1.1);
   * the full-fidelity copy here is ephemeral and bounded, and the /replay reads
   * that expose it require the control-plane bearer token. So redaction is the
   * complete durable-PII solution — the full trace does not migrate to another
   * persistent store.
   */
  private readonly fullTraces = new Map<string, SessionTrace>();
  readonly inbox: ApprovalInbox;
  readonly policy: PolicyEditor;
  readonly grants: OperatorGrantInbox | null;
  private readonly backend: ControlPlaneBackend | null;
  /** When set, every state-changing route requires `Authorization: Bearer <token>`. */
  private readonly authToken: string | null;

  constructor(initial?: Partial<PolicyConfig>, backend?: ControlPlaneBackend, authToken?: string) {
    this.inbox = new ApprovalInbox();
    this.policy = new PolicyEditor(initial);
    this.backend = backend ?? null;
    this.authToken = authToken ?? null;
    this.grants = backend ? new OperatorGrantInbox(backend.kernel) : null;

    // Forward approval queue changes to SSE clients
    this.inbox.onRequest(() => {
      this.broadcast({ type: "approvals", data: this.inbox.pendingList() });
    });
  }

  /** Raise a pending operator-grant request (called by the gateway observer). */
  requestOperatorGrant(scope: { tool: string; sessionId: string }, summary: string): void {
    if (!this.grants) return;
    this.grants.request(scope, summary);
    this.broadcast({ type: "operator-grants", data: this.grants.pendingList() });
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
    this.fullTraces.set(trace.traceId, trace);
    if (this.fullTraces.size > 50) {
      const oldest = this.fullTraces.keys().next().value;
      if (oldest !== undefined) this.fullTraces.delete(oldest);
    }
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

    // No wildcard CORS: the UI is served same-origin, so it needs no CORS grant.
    // A `*` here let a malicious cross-origin page POST to the credentialed routes
    // (e.g. mint+read an operator grant token). Same-origin requests are
    // unaffected; cross-origin reads are now blocked by the browser.
    if (method === "OPTIONS") { res.writeHead(204).end(); return; }

    // State-changing routes require a bearer token when one is configured. The
    // token is NOT an ambient credential (no cookie), so a cross-origin page
    // cannot forge it — this closes both the open-approval hole and CSRF.
    //
    // The /replay reads are an exception to the "GET is open" rule: they serve
    // the FULL, un-redacted trace (page text, typed values — PII). Unlike the
    // redacted Svod copy, this is the operator's full-fidelity view, so it must
    // require the token too — otherwise the one PII surface bypasses auth.
    // /vault and /personas are operator read surfaces (they reveal which origins
    // hold credentials / which personas exist) — token-gated like /replay, even
    // though they never return secret VALUES.
    const isPiiRead = method === "GET" &&
      (path === "/replay" || path.startsWith("/replay/") || path === "/vault" || path === "/personas");
    if (this.authToken && (method !== "GET" || isPiiRead)) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${this.authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

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
      const patch = JSON.parse(body) as Partial<PolicyConfig> & { budgetLimit?: number };
      // Apply to the LIVE kernel when wired (human is the grant authority; the
      // floor still re-asserts). Fall back to the display-only editor otherwise.
      const applied = this.backend ? this.backend.applyPolicy(patch) : this.policy.update(patch);
      this.policy.update(applied); // keep the snapshot in sync for GET /policy
      if (this.backend && typeof patch.budgetLimit === "number") this.backend.setBudget(patch.budgetLimit);
      this.broadcast({ type: "policy", data: applied });
      json(res, applied);
      return;
    }

    // Human-initiated persona import from a real browser profile.
    if (this.backend && method === "POST" && path === "/persona-import") {
      const body = await readBody(req);
      const { personaId, profile, origins } = (body ? JSON.parse(body) : {}) as
        { personaId?: string; profile?: string; origins?: string[] };
      if (!personaId || !origins || !origins.length) { res.writeHead(400).end("personaId and origins required"); return; }
      try {
        const result = await this.backend.importPersona(personaId, profile ?? "Default", origins);
        json(res, { ...result, note: "credentials imported into the persona vault — values never exposed" });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    if (method === "GET" && path === "/traces") {
      json(res, { traces: this.traces });
      return;
    }

    // Visual replay: perception snapshots vs actions on one timeline.
    const replayMatch = path.match(/^\/replay\/([^/]+)$/);
    // JSON trace-detail for the native event-timeline (token-gated above). Returns
    // the SAME redacted timeline projection the HTML replay renders — no raw page
    // text/values, just summarized rows.
    const replayEventsMatch = path.match(/^\/replay\/([^/]+)\/events$/);
    if (method === "GET" && replayEventsMatch) {
      const trace = this.fullTraces.get(replayEventsMatch[1]!);
      if (!trace) { res.writeHead(404).end("trace not found"); return; }
      json(res, {
        traceId: trace.traceId,
        sessionId: trace.sessionId,
        startTs: trace.startTs,
        events: traceEventRows(trace),
      });
      return;
    }

    if (method === "GET" && replayMatch) {
      const trace = this.fullTraces.get(replayMatch[1]!);
      if (!trace) { res.writeHead(404).end("trace not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(buildReplayPage(trace));
      return;
    }

    if (method === "GET" && path === "/replay") {
      json(res, { traces: Array.from(this.fullTraces.keys()) });
      return;
    }

    // Operator read surfaces (token-gated): personas (id/origins/sessions) and
    // vault entries (id/origin/label — NEVER credential values).
    if (this.backend && method === "GET" && path === "/personas") {
      json(res, { personas: this.backend.listPersonas() });
      return;
    }
    if (this.backend && method === "GET" && path === "/vault") {
      json(res, { vault: this.backend.listVault() });
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

    // ── Operator-grant inbox (UI approves → mints on the shared kernel) ────────
    if (this.grants && method === "GET" && path === "/operator-grants") {
      json(res, { grants: this.grants.pendingList() });
      return;
    }
    const grantApprove = path.match(/^\/operator-grants\/([^/]+)\/approve$/);
    if (this.grants && method === "POST" && grantApprove) {
      const outcome = this.grants.approve(grantApprove[1]!);
      this.broadcast({ type: "operator-grants", data: this.grants.pendingList() });
      json(res, outcome); // { outcome:"approved", grant:"<token>" } — relayed to the agent
      return;
    }
    const grantDeny = path.match(/^\/operator-grants\/([^/]+)\/deny$/);
    if (this.grants && method === "POST" && grantDeny) {
      const body = await readBody(req);
      const { reason } = (body ? JSON.parse(body) : {}) as { reason?: string };
      const outcome = this.grants.deny(grantDeny[1]!, reason);
      this.broadcast({ type: "operator-grants", data: this.grants.pendingList() });
      json(res, outcome);
      return;
    }

    // ── Device OOB verification ────────────────────────────────────────────────
    const deviceVerify = path.match(/^\/devices\/([^/]+)\/verify$/);
    if (this.backend && method === "POST" && deviceVerify) {
      const body = await readBody(req);
      const { challenge } = (body ? JSON.parse(body) : {}) as { challenge?: string };
      const verified = this.backend.verifyDevice(deviceVerify[1]!, challenge ?? "");
      json(res, { verified });
      return;
    }

    // ── Human handoff (claim / approve / mediated input) ───────────────────────
    if (this.backend && method === "GET" && path === "/handoffs") {
      json(res, { handoffs: this.backend.handoffs.pending() });
      return;
    }
    const handoffPage = path.match(/^\/handoff\/([^/]+)$/);
    if (this.backend && method === "GET" && handoffPage) {
      const h = this.backend.handoffs.get(handoffPage[1]!);
      if (!h) { res.writeHead(404).end("handoff not found"); return; }
      // Anti-phishing: render ONLY when the signature verifies.
      if (!this.backend.handoffs.verifySignature(h)) { res.writeHead(403).end("invalid signature"); return; }
      if (h.status === "expired") { res.writeHead(410).end("handoff expired"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(buildHandoffPage(h));
      return;
    }
    const handoffClaim = path.match(/^\/handoff\/([^/]+)\/claim$/);
    if (this.backend && method === "POST" && handoffClaim) {
      const body = await readBody(req);
      const { deviceId } = (body ? JSON.parse(body) : {}) as { deviceId?: string };
      const claimed = this.backend.handoffs.claim(handoffClaim[1]!, deviceId ?? "web");
      this.broadcast({ type: "handoffs", data: this.backend.handoffs.pending() });
      json(res, { claimed });
      return;
    }
    const handoffApprove = path.match(/^\/handoff\/([^/]+)\/approve$/);
    if (this.backend && method === "POST" && handoffApprove) {
      const body = await readBody(req);
      const { deviceId, approved } = (body ? JSON.parse(body) : {}) as { deviceId?: string; approved?: boolean };
      const ok2 = this.backend.handoffs.resolveApproval(handoffApprove[1]!, deviceId ?? "web", approved !== false);
      this.broadcast({ type: "handoffs", data: this.backend.handoffs.pending() });
      json(res, { resolved: ok2 });
      return;
    }
    const handoffInput = path.match(/^\/handoff\/([^/]+)\/input$/);
    if (this.backend && method === "POST" && handoffInput) {
      const body = await readBody(req);
      const { deviceId, sessionId, fieldNodeId, value } = (body ? JSON.parse(body) : {}) as
        { deviceId?: string; sessionId?: string; fieldNodeId?: string; value?: string };
      // The value flows backend→form via Vault; it is never echoed back here.
      const filled = await this.backend.submitHandoffInput(
        handoffInput[1]!, deviceId ?? "web", sessionId ?? "", fieldNodeId ?? "", value ?? "",
      );
      this.broadcast({ type: "handoffs", data: this.backend.handoffs.pending() });
      json(res, { filled, note: "value written to the form — not retained" });
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
