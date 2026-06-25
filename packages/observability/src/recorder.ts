/**
 * TraceRecorder — captures trace events for a single session.
 * Thread-safe for single-session sequential use.
 */

import { randomUUID } from "node:crypto";
import type { ActionCommand } from "@lattice/action";
import type { IGNode, FidelityTier } from "@lattice/perception";
import type {
  ActionResultEvent,
  ActionEvent,
  DeltaEvent,
  GrantEvent,
  MetricsEvent,
  NetworkEvent,
  SessionEndEvent,
  SessionStartEvent,
  SessionTrace,
  SnapshotEvent,
  TraceEvent,
} from "./types.js";

export class TraceRecorder {
  readonly traceId: string;
  private readonly startTs: number;
  private readonly events: TraceEvent[] = [];
  private seq = 0;
  private tierDistribution: Record<string, number> = {};
  private successCount = 0;
  private actionCount = 0;

  constructor(readonly sessionId: string, readonly topology: "ephemeral" | "persistent" = "ephemeral") {
    this.traceId = randomUUID();
    this.startTs = Date.now();
    this.push({
      kind: "session_start",
      traceId: this.traceId,
      sessionId,
      ts: this.startTs,
      seq: this.nextSeq(),
      topology,
    } satisfies SessionStartEvent);
  }

  recordSnapshot(
    tier: FidelityTier,
    url: string,
    title: string,
    nodes: readonly IGNode[],
  ): void {
    this.tierDistribution[tier] = (this.tierDistribution[tier] ?? 0) + 1;
    this.push({
      kind: "snapshot",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      tier,
      url,
      title,
      nodeCount: nodes.length,
      nodes,
    } satisfies SnapshotEvent);
  }

  recordAction(command: ActionCommand): void {
    this.actionCount += 1;
    this.push({
      kind: "action",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      command,
    } satisfies ActionEvent);
  }

  recordActionResult(success: boolean, url: string, extracted?: unknown, error?: string): void {
    if (success) this.successCount += 1;
    this.push({
      kind: "action_result",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      success,
      url,
      ...(extracted !== undefined ? { extracted } : {}),
      ...(error !== undefined ? { error } : {}),
    } satisfies ActionResultEvent);
  }

  recordDelta(added: number, removed: number, updated: number, url: string): void {
    this.push({
      kind: "delta",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      added,
      removed,
      updated,
      url,
    } satisfies DeltaEvent);
  }

  recordGrant(
    actionType: string,
    policyClass: string,
    granted: boolean,
    detail: string,
  ): void {
    this.push({
      kind: "grant",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      actionType,
      policyClass,
      granted,
      detail,
    } satisfies GrantEvent);
  }

  recordNetwork(url: string, method: string, status?: number, byteLength?: number): void {
    this.push({
      kind: "network",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: Date.now(),
      seq: this.nextSeq(),
      url,
      method,
      ...(status !== undefined ? { status } : {}),
      ...(byteLength !== undefined ? { byteLength } : {}),
    } satisfies NetworkEvent);
  }

  finish(): SessionTrace {
    const endTs = Date.now();
    const durationMs = endTs - this.startTs;
    const successRate = this.actionCount > 0 ? this.successCount / this.actionCount : 1;

    const metrics: MetricsEvent = {
      kind: "metrics",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: endTs,
      seq: this.nextSeq(),
      totalActions: this.actionCount,
      successCount: this.successCount,
      successRate,
      tierDistribution: { ...this.tierDistribution },
      durationMs,
    };
    this.push(metrics);

    this.push({
      kind: "session_end",
      traceId: this.traceId,
      sessionId: this.sessionId,
      ts: endTs,
      seq: this.nextSeq(),
      durationMs,
    } satisfies SessionEndEvent);

    return {
      traceId: this.traceId,
      sessionId: this.sessionId,
      startTs: this.startTs,
      endTs,
      events: [...this.events],
    };
  }

  events_(): readonly TraceEvent[] {
    return this.events;
  }

  private push(event: TraceEvent): void {
    this.events.push(event);
  }

  private nextSeq(): number {
    return this.seq++;
  }
}
