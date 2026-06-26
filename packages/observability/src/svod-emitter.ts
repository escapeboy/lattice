/**
 * SvodEmitter — writes a session trace to Svod as a structured note.
 *
 * The SvodWriteFn is injected so the emitter works both in Claude Code context
 * (where mcp__svod__write is available) and in custom integrations.
 */

import type { SessionTrace, SvodWriteFn } from "./types.js";
import { extractMetrics, formatMetrics } from "./metrics.js";
import { redactTrace, DEFAULT_PII_POLICY, type PiiPolicy } from "./redact.js";

/**
 * Write a session trace to Svod. PII is redacted BEFORE persistence by default
 * (P1.1) — pass a policy to log specific origins in full. The Svod store is
 * immutable, so raw PII must never reach it; redaction here is the boundary.
 */
export async function emitToSvod(
  trace: SessionTrace,
  write: SvodWriteFn,
  pathPrefix = "projects/lattice/traces",
  policy: PiiPolicy = DEFAULT_PII_POLICY,
): Promise<string> {
  trace = redactTrace(trace, policy);
  const metrics = extractMetrics(trace);
  const date = new Date(trace.startTs).toISOString().slice(0, 19).replace("T", " ");

  const content = [
    `# Lattice Trace — ${trace.traceId}`,
    ``,
    `**Session:** ${trace.sessionId}  `,
    `**Recorded:** ${date} UTC  `,
    `**Duration:** ${metrics.durationMs}ms`,
    ``,
    `## Metrics`,
    ``,
    "```",
    formatMetrics(metrics),
    "```",
    ``,
    `## Event Summary`,
    ``,
    `| Kind | Count |`,
    `|------|-------|`,
    ...Object.entries(metrics.eventCounts).map(([k, v]) => `| ${k} | ${v} |`),
    ``,
    `## Events`,
    ``,
    ...trace.events.map((e) => {
      const ts = new Date(e.ts).toISOString().slice(11, 23);
      switch (e.kind) {
        case "session_start": return `- \`${ts}\` **session_start** topology=${e.topology}`;
        case "session_end": return `- \`${ts}\` **session_end** duration=${e.durationMs}ms`;
        case "snapshot": return `- \`${ts}\` **snapshot** tier=${e.tier} nodes=${e.nodeCount} url=${e.url}`;
        case "action": return `- \`${ts}\` **action** ${e.command.type}${e.command.type === "navigate" ? ` → ${e.command.url}` : ""}`;
        case "action_result": return `- \`${ts}\` **action_result** success=${e.success} url=${e.url}${e.error ? ` error=${e.error}` : ""}`;
        case "delta": return `- \`${ts}\` **delta** +${e.added}/-${e.removed}/~${e.updated}`;
        case "grant": return `- \`${ts}\` **grant** ${e.actionType} → ${e.policyClass} granted=${e.granted}`;
        case "network": return `- \`${ts}\` **network** ${e.method} ${e.url}${e.status !== undefined ? ` ${e.status}` : ""}`;
        case "metrics": return `- \`${ts}\` **metrics** actions=${e.totalActions} success=${(e.successRate * 100).toFixed(1)}%`;
        default: return `- \`${ts}\` **${(e as { kind: string }).kind}**`;
      }
    }),
  ].join("\n");

  const path = `${pathPrefix}/${trace.traceId}.md`;
  await write(path, content);
  return path;
}
