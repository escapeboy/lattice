/**
 * Visual replay viewer — renders a recorded SessionTrace as a single timeline
 * showing what the agent PERCEIVED (snapshots, deltas) next to what it DID
 * (actions, results) and what was GATED (grants). This is the "what it saw vs
 * what it did" surface from architecture §8, as a static HTML page.
 */

import type { SessionTrace, TraceEvent } from "@lattice/observability";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export interface TraceEventRow { lane: string; cls: string; text: string; rel: number }

/**
 * The redacted timeline projection of a trace — the same "what it saw vs what it
 * did" summary the HTML replay renders, as structured rows. Values are summarized
 * (action values truncated, no raw form contents), matching the PII posture of
 * every trace surface. Used by the JSON `/replay/:id` endpoint (native timeline).
 */
export function traceEventRows(trace: SessionTrace): TraceEventRow[] {
  const t0 = trace.startTs;
  return trace.events.map((e) => rowFor(e, t0));
}

function rowFor(e: TraceEvent, t0: number): TraceEventRow {
  const rel = e.ts - t0;
  switch (e.kind) {
    case "session_start": return { lane: "meta", cls: "meta", text: `session start (${e.topology})`, rel };
    case "session_end": return { lane: "meta", cls: "meta", text: `session end · ${e.durationMs}ms`, rel };
    case "snapshot": return { lane: "perceive", cls: "perceive", text: `perceive ${e.tier} · ${e.nodeCount} nodes · ${esc(e.title || e.url)}`, rel };
    case "delta": return { lane: "perceive", cls: "delta", text: `delta +${e.added}/−${e.removed}/~${e.updated}`, rel };
    case "action": {
      const v = "value" in e.command && typeof e.command.value === "string" ? e.command.value : "";
      return { lane: "act", cls: "act", text: `act ${esc(e.command.type)}${v ? ` = ${esc(v).slice(0, 24)}` : ""}`, rel };
    }
    case "action_result": return { lane: "act", cls: e.success ? "ok" : "fail", text: `→ ${e.success ? "ok" : "fail"}${e.error ? ` (${esc(e.error)})` : ""}`, rel };
    case "grant": return { lane: "gate", cls: e.granted ? "ok" : "fail", text: `grant ${e.granted ? "✓" : "✗"} ${esc(e.actionType)} [${esc(e.policyClass)}]`, rel };
    case "network": return { lane: "net", cls: "net", text: `net ${esc(e.method)} ${e.status ?? ""} ${esc(e.url).slice(0, 40)}`, rel };
    case "metrics": return { lane: "meta", cls: "meta", text: `metrics · ${e.totalActions} actions · ${Math.round(e.successRate * 100)}% ok`, rel };
  }
}

export function buildReplayPage(trace: SessionTrace): string {
  const t0 = trace.startTs;
  const rows = trace.events.map((e) => rowFor(e, t0));
  return renderReplayHtml(trace.traceId, trace.sessionId, rows, trace.endTs - trace.startTs);
}

/** Build the replay HTML from already-projected rows (a restored archive trace,
 *  where the full SessionTrace is no longer in memory). */
export function buildReplayPageFromRows(traceId: string, sessionId: string, rows: TraceEventRow[]): string {
  const durationMs = rows.length ? rows[rows.length - 1]!.rel : 0;
  return renderReplayHtml(traceId, sessionId, rows, durationMs);
}

function renderReplayHtml(traceId: string, sessionId: string, rows: TraceEventRow[], durationMs: number): string {
  const body = rows
    .map((r) => `<tr class="${r.cls}"><td class="t">+${r.rel}ms</td><td class="lane ${r.lane}">${r.lane}</td><td>${r.text}</td></tr>`)
    .join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replay · ${esc(traceId.slice(0, 8))}</title>
<style>
  body{font:14px ui-monospace,monospace;margin:0;background:#0f1115;color:#e6e6e6}
  header{padding:16px 20px;border-bottom:1px solid #2a2f3a}
  h1{font-size:16px;margin:0}.sub{color:#8b93a7;font-size:12px;margin-top:4px}
  table{width:100%;border-collapse:collapse}
  td{padding:6px 12px;border-bottom:1px solid #1c2027;vertical-align:top}
  .t{color:#5b6373;width:80px;white-space:nowrap}
  .lane{width:72px;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
  .lane.perceive{color:#60a5fa}.lane.act{color:#34d399}.lane.gate{color:#fbbf24}.lane.net{color:#a78bfa}.lane.meta{color:#8b93a7}
  tr.fail td{color:#f87171}tr.ok td:last-child{color:#86efac}tr.delta td:last-child{color:#93c5fd}
</style></head><body>
  <header>
    <h1>Session replay — ${esc(traceId)}</h1>
    <div class="sub">session ${esc(sessionId)} · ${rows.length} events · ${durationMs}ms · perceive vs act vs gate</div>
  </header>
  <table><tbody>${body}</tbody></table>
</body></html>`;
}
