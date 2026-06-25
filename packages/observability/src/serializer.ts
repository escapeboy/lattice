/**
 * JSONL serializer for session traces.
 * One JSON object per line — streamable, diffable, deterministically replayable.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { SessionTrace, TraceEvent } from "./types.js";

export function serializeTrace(trace: SessionTrace): string {
  // Header line: trace metadata
  const header = { _type: "trace_header", traceId: trace.traceId, sessionId: trace.sessionId, startTs: trace.startTs, endTs: trace.endTs };
  const lines = [JSON.stringify(header)];
  for (const event of trace.events) {
    lines.push(JSON.stringify(event));
  }
  return lines.join("\n") + "\n";
}

export function deserializeTrace(jsonl: string): SessionTrace {
  const lines = jsonl.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("Empty JSONL — cannot deserialize trace");

  const header = JSON.parse(lines[0]!) as {
    _type: string;
    traceId: string;
    sessionId: string;
    startTs: number;
    endTs: number;
  };
  if (header._type !== "trace_header") throw new Error("First line must be trace_header");

  const events: TraceEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    events.push(JSON.parse(lines[i]!) as TraceEvent);
  }

  return {
    traceId: header.traceId,
    sessionId: header.sessionId,
    startTs: header.startTs,
    endTs: header.endTs,
    events,
  };
}

export async function writeTraceFile(filePath: string, trace: SessionTrace): Promise<void> {
  await writeFile(filePath, serializeTrace(trace), "utf8");
}

export async function readTraceFile(filePath: string): Promise<SessionTrace> {
  const content = await readFile(filePath, "utf8");
  return deserializeTrace(content);
}
