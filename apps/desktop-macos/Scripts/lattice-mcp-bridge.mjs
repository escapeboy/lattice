#!/usr/bin/env node
// lattice-mcp-bridge — minimal stdio ⇄ streamable-HTTP bridge for the Lattice gateway MCP.
//
// Replaces `mcp-remote`, which wedges permanently when the gateway restarts: it gives up
// SSE reconnection after 2 attempts and then swallows the 404 "Session not found" on every
// subsequent POST without answering the client — each tool call hangs until the client's
// 4-minute timeout (incident 2026-07-03, svod). This bridge instead:
//   * caps every request (LATTICE_BRIDGE_TIMEOUT_MS, default 60s) and returns a JSON-RPC
//     error instead of hanging;
//   * on 404 (session lost — gateway restarted) transparently re-initializes and retries
//     the call once;
//   * skips SSE entirely — the gateway answers POSTs with JSON (enableJsonResponse) and
//     the only server-initiated push (`notifications/perceive` from perceive_subscribe)
//     is opt-in with polling alternatives (perceive_snapshot/perceive_delta); approvals
//     flow through the control plane, not MCP push. No stream to lose.
//
// Env: LATTICE_MCP_URL (default http://127.0.0.1:8765/mcp), LATTICE_AUTH ("Bearer <token>"),
//      LATTICE_BRIDGE_TIMEOUT_MS.

import { createInterface } from "node:readline";

const URL_ = process.env.LATTICE_MCP_URL || "http://127.0.0.1:8765/mcp";
const AUTH = process.env.LATTICE_AUTH || "";
const TIMEOUT = Number(process.env.LATTICE_BRIDGE_TIMEOUT_MS || 60_000);

let sessionId = null;
let initParams = null;   // client's initialize params, replayed on re-init
let reinitInFlight = null;

const log = (msg) => process.stderr.write(`[lattice-bridge] ${msg}\n`);
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function headers() {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (AUTH) h["Authorization"] = AUTH;
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

/** POST one JSON-RPC message. Returns {status, json|null} or throws on network/timeout. */
async function post(msg) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid && sid !== sessionId) log(`session: ${sid}`);
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!text) return { status: res.status, json: null };
  // enableJsonResponse gives plain JSON; tolerate an SSE-framed body just in case.
  const m = /^data: (.*)$/m.exec(text);
  try { return { status: res.status, json: JSON.parse(m ? m[1] : text) }; }
  catch { return { status: res.status, json: null, text }; }
}

/** Re-initialize after a lost session (single-flight). */
function reinitialize() {
  if (reinitInFlight) return reinitInFlight;
  reinitInFlight = (async () => {
    sessionId = null;
    const params = initParams || {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "lattice-bridge", version: "1.0" },
    };
    const r = await post({ jsonrpc: "2.0", id: "bridge-reinit", method: "initialize", params });
    if (r.status !== 200 || !sessionId) throw new Error(`re-initialize failed: HTTP ${r.status}`);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    log(`session re-initialized: ${sessionId}`);
  })().finally(() => { reinitInFlight = null; });
  return reinitInFlight;
}

function rpcError(id, message, code = -32001) {
  return { jsonrpc: "2.0", id, error: { code, message: `lattice-bridge: ${message}` } };
}

// The gateway signals a stale session on POST as HTTP 400 with an id:null error body
// ("no valid session — send initialize first", server.ts), not the spec's 404 — match both.
function sessionLost(r) {
  return r.status === 404 ||
    (r.status === 400 && sessionId && r.json?.error && r.json?.id == null);
}

async function handleRequest(msg) {
  if (msg.method === "initialize") initParams = msg.params;
  try {
    let r = await post(msg);
    if (sessionLost(r)) {             // session lost (gateway restarted) → recover
      log(`HTTP ${r.status} for ${msg.method} — session lost, re-initializing`);
      await reinitialize();
      r = await post(msg);
    }
    if (sessionLost(r)) send(rpcError(msg.id, `session recovery failed (HTTP ${r.status})`));
    else if (r.json != null) send(r.json);
    else if (r.status >= 400) send(rpcError(msg.id, `HTTP ${r.status} from gateway`));
    else send(rpcError(msg.id, `empty response (HTTP ${r.status})`));
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timed out after ${TIMEOUT}ms` : (e.message || String(e));
    log(`${msg.method} id=${msg.id} failed: ${why}`);
    send(rpcError(msg.id, why));
  }
}

async function handleNotification(msg) {
  try { await post(msg); } catch (e) { log(`notification ${msg.method} dropped: ${e.message}`); }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log(`unparseable input dropped: ${line.slice(0, 120)}`); return; }
  if (msg.id !== undefined && msg.method) handleRequest(msg);
  else if (msg.method) handleNotification(msg);
  // responses from client (to server requests) can't occur: the gateway never sends requests
});
rl.on("close", () => process.exit(0));
log(`ready → ${URL_} (timeout ${TIMEOUT}ms)`);
