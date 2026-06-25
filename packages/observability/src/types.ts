/**
 * Observability types — trace events, session traces, replay results.
 */

import type { ActionCommand } from "@lattice/action";
import type { IGNode, FidelityTier } from "@lattice/perception";

export type TraceEventKind =
  | "session_start"
  | "session_end"
  | "snapshot"
  | "action"
  | "action_result"
  | "delta"
  | "grant"
  | "network"
  | "metrics";

interface BaseEvent {
  readonly kind: TraceEventKind;
  readonly traceId: string;
  readonly sessionId: string;
  readonly ts: number;
  readonly seq: number;
}

export interface SessionStartEvent extends BaseEvent {
  readonly kind: "session_start";
  readonly topology: "ephemeral" | "persistent";
}

export interface SessionEndEvent extends BaseEvent {
  readonly kind: "session_end";
  readonly durationMs: number;
}

export interface SnapshotEvent extends BaseEvent {
  readonly kind: "snapshot";
  readonly tier: FidelityTier;
  readonly url: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly nodes: readonly IGNode[];
}

export interface ActionEvent extends BaseEvent {
  readonly kind: "action";
  readonly command: ActionCommand;
}

export interface ActionResultEvent extends BaseEvent {
  readonly kind: "action_result";
  readonly success: boolean;
  readonly url: string;
  readonly extracted?: unknown;
  readonly error?: string;
}

export interface DeltaEvent extends BaseEvent {
  readonly kind: "delta";
  readonly added: number;
  readonly removed: number;
  readonly updated: number;
  readonly url: string;
}

export interface GrantEvent extends BaseEvent {
  readonly kind: "grant";
  readonly actionType: string;
  readonly policyClass: string;
  readonly granted: boolean;
  readonly detail: string;
}

export interface NetworkEvent extends BaseEvent {
  readonly kind: "network";
  readonly url: string;
  readonly method: string;
  readonly status?: number;
  readonly byteLength?: number;
}

export interface MetricsEvent extends BaseEvent {
  readonly kind: "metrics";
  readonly totalActions: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly tierDistribution: Record<string, number>;
  readonly durationMs: number;
}

export type TraceEvent =
  | SessionStartEvent
  | SessionEndEvent
  | SnapshotEvent
  | ActionEvent
  | ActionResultEvent
  | DeltaEvent
  | GrantEvent
  | NetworkEvent
  | MetricsEvent;

export interface SessionTrace {
  readonly traceId: string;
  readonly sessionId: string;
  readonly startTs: number;
  readonly endTs: number;
  readonly events: readonly TraceEvent[];
}

export interface SnapshotDiff {
  readonly addedNodes: number;
  readonly removedNodes: number;
  readonly updatedNodes: number;
  readonly addedNodeIds: string[];
  readonly removedNodeIds: string[];
  readonly updatedNodeIds: string[];
}

export interface ReplayResult {
  readonly traceId: string;
  readonly replayedAt: number;
  readonly actionsReplayed: number;
  readonly snapshotDiffs: SnapshotDiff[];
  readonly liveSnapshotNodeCount: number;
  readonly recordedSnapshotNodeCount: number;
  readonly diverged: boolean;
}

export type SvodWriteFn = (path: string, content: string) => Promise<void>;
