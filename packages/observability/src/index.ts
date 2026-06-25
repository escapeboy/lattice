/**
 * @lattice/observability — trace recording, replay, metrics, Svod emission.
 */

export type {
  ActionEvent,
  ActionResultEvent,
  DeltaEvent,
  GrantEvent,
  MetricsEvent,
  NetworkEvent,
  ReplayResult,
  SessionEndEvent,
  SessionStartEvent,
  SessionTrace,
  SnapshotDiff,
  SnapshotEvent,
  SvodWriteFn,
  TraceEvent,
  TraceEventKind,
} from "./types.js";

export { TraceRecorder } from "./recorder.js";
export { serializeTrace, deserializeTrace, writeTraceFile, readTraceFile } from "./serializer.js";
export { SessionReplayer } from "./replayer.js";
export { extractMetrics, formatMetrics } from "./metrics.js";
export type { TraceMetrics } from "./metrics.js";
export { emitToSvod } from "./svod-emitter.js";
export { renderTrace, renderReplayDiff } from "./viewer.js";
