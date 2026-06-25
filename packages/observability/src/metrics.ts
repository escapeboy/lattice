/**
 * Metrics extraction from a SessionTrace.
 */

import type { MetricsEvent, SessionTrace } from "./types.js";

export interface TraceMetrics {
  traceId: string;
  sessionId: string;
  durationMs: number;
  totalActions: number;
  successCount: number;
  successRate: number;
  tierDistribution: Record<string, number>;
  eventCounts: Record<string, number>;
  networkRequestCount: number;
  grantCount: number;
  denialCount: number;
}

export function extractMetrics(trace: SessionTrace): TraceMetrics {
  const metricsEvent = trace.events.find((e): e is MetricsEvent => e.kind === "metrics");

  const eventCounts: Record<string, number> = {};
  let networkRequestCount = 0;
  let grantCount = 0;
  let denialCount = 0;

  for (const event of trace.events) {
    eventCounts[event.kind] = (eventCounts[event.kind] ?? 0) + 1;
    if (event.kind === "network") networkRequestCount += 1;
    if (event.kind === "grant") {
      if (event.granted) grantCount += 1;
      else denialCount += 1;
    }
  }

  return {
    traceId: trace.traceId,
    sessionId: trace.sessionId,
    durationMs: trace.endTs - trace.startTs,
    totalActions: metricsEvent?.totalActions ?? 0,
    successCount: metricsEvent?.successCount ?? 0,
    successRate: metricsEvent?.successRate ?? 1,
    tierDistribution: metricsEvent?.tierDistribution ?? {},
    eventCounts,
    networkRequestCount,
    grantCount,
    denialCount,
  };
}

export function formatMetrics(metrics: TraceMetrics): string {
  const lines = [
    `Trace:    ${metrics.traceId}`,
    `Session:  ${metrics.sessionId}`,
    `Duration: ${metrics.durationMs}ms`,
    `Actions:  ${metrics.totalActions} total, ${metrics.successCount} succeeded (${(metrics.successRate * 100).toFixed(1)}%)`,
    `Network:  ${metrics.networkRequestCount} requests`,
    `Grants:   ${metrics.grantCount} allowed, ${metrics.denialCount} denied`,
    `Tiers:    ${Object.entries(metrics.tierDistribution).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`,
    `Events:   ${Object.entries(metrics.eventCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  ];
  return lines.join("\n");
}
