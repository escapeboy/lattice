/**
 * CLI trace viewer — pretty-print a session trace.
 */

import type { SessionTrace, TraceEvent } from "./types.js";
import { extractMetrics, formatMetrics } from "./metrics.js";

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

function fmtEvent(e: TraceEvent): string {
  const prefix = `[${fmtTs(e.ts)}] [${e.seq.toString().padStart(4, "0")}] ${e.kind.padEnd(14)}`;
  switch (e.kind) {
    case "session_start": return `${prefix} topology=${e.topology}`;
    case "session_end":   return `${prefix} duration=${e.durationMs}ms`;
    case "snapshot":      return `${prefix} tier=${e.tier} nodes=${e.nodeCount} ${e.url}`;
    case "action":        return `${prefix} ${e.command.type}${"url" in e.command ? ` → ${(e.command as { url: string }).url}` : ""}`;
    case "action_result": return `${prefix} success=${e.success} ${e.url}${e.error ? ` ERROR=${e.error}` : ""}`;
    case "delta":         return `${prefix} +${e.added}/-${e.removed}/~${e.updated} ${e.url}`;
    case "grant":         return `${prefix} ${e.actionType} (${e.policyClass}) granted=${e.granted}`;
    case "network":       return `${prefix} ${e.method} ${e.url}${e.status !== undefined ? ` ${e.status}` : ""}`;
    case "metrics":       return `${prefix} actions=${e.totalActions} success=${(e.successRate * 100).toFixed(1)}%`;
    default:              return `${prefix}`;
  }
}

export function renderTrace(trace: SessionTrace): string {
  const header = [
    "═".repeat(80),
    `Lattice Session Trace`,
    `  ID:       ${trace.traceId}`,
    `  Session:  ${trace.sessionId}`,
    `  Start:    ${new Date(trace.startTs).toISOString()}`,
    `  End:      ${new Date(trace.endTs).toISOString()}`,
    `  Duration: ${trace.endTs - trace.startTs}ms`,
    "─".repeat(80),
  ].join("\n");

  const events = trace.events.map(fmtEvent).join("\n");

  const metrics = [
    "─".repeat(80),
    "Metrics:",
    formatMetrics(extractMetrics(trace)),
    "═".repeat(80),
  ].join("\n");

  return [header, events, metrics].join("\n");
}

export function renderReplayDiff(
  trace: SessionTrace,
  liveNodeCount: number,
  diffs: Array<{ addedNodes: number; removedNodes: number; updatedNodes: number; addedNodeIds: string[]; removedNodeIds: string[] }>,
): string {
  const recorded = trace.events.filter((e) => e.kind === "snapshot").pop();
  const recordedCount = recorded?.kind === "snapshot" ? recorded.nodeCount : 0;

  const lines = [
    "═".repeat(80),
    `Replay Diff — Trace ${trace.traceId}`,
    `  Recorded node count: ${recordedCount}`,
    `  Live node count:     ${liveNodeCount}`,
    "─".repeat(80),
  ];

  if (diffs.length === 0) {
    lines.push("  No snapshot diffs.");
  } else {
    for (let i = 0; i < diffs.length; i++) {
      const d = diffs[i]!;
      lines.push(`  Snapshot diff [${i}]:`);
      lines.push(`    Added:   ${d.addedNodes}${d.addedNodeIds.length > 0 ? ` (${d.addedNodeIds.slice(0, 5).join(", ")}${d.addedNodeIds.length > 5 ? "…" : ""})` : ""}`);
      lines.push(`    Removed: ${d.removedNodes}${d.removedNodeIds.length > 0 ? ` (${d.removedNodeIds.slice(0, 5).join(", ")}${d.removedNodeIds.length > 5 ? "…" : ""})` : ""}`);
      lines.push(`    Updated: ${d.updatedNodes}`);
    }
  }

  lines.push("═".repeat(80));
  return lines.join("\n");
}
