/**
 * SessionReplayer — deterministically replays a recorded session.
 *
 * Replay strategy:
 *   1. Open fresh context
 *   2. Re-execute action events in order (navigate, fill, act, submit, extract)
 *   3. After each snapshot event's corresponding action, take live snapshot
 *   4. Diff recorded vs live snapshots → SnapshotDiff[]
 *   5. Return ReplayResult
 */

import type { EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { InteractionGraph } from "@lattice/perception";
import { createActionEngine } from "@lattice/action";
import type { ActionEvent, ReplayResult, SessionTrace, SnapshotDiff, SnapshotEvent } from "./types.js";

function diffSnapshots(recorded: SnapshotEvent, live: InteractionGraph): SnapshotDiff {
  const recordedIds = new Set(recorded.nodes.map((n) => n.id));
  const liveIds = new Set(Array.from(live.nodes.values()).map((n) => n.id));

  const addedNodeIds: string[] = [];
  const removedNodeIds: string[] = [];
  const updatedNodeIds: string[] = [];

  for (const id of liveIds) {
    if (!recordedIds.has(id)) addedNodeIds.push(id);
  }
  for (const id of recordedIds) {
    if (!liveIds.has(id)) removedNodeIds.push(id);
  }

  // Check for updated nodes (same id, different label or state)
  for (const id of recordedIds) {
    if (!liveIds.has(id)) continue;
    const recNode = recorded.nodes.find((n) => n.id === id);
    const liveNode = live.nodes.get(id);
    if (recNode && liveNode && JSON.stringify(recNode) !== JSON.stringify(liveNode)) {
      updatedNodeIds.push(id);
    }
  }

  return {
    addedNodes: addedNodeIds.length,
    removedNodes: removedNodeIds.length,
    updatedNodes: updatedNodeIds.length,
    addedNodeIds,
    removedNodeIds,
    updatedNodeIds,
  };
}

export class SessionReplayer {
  constructor(private readonly engine: EngineAdapter) {}

  async replay(trace: SessionTrace): Promise<ReplayResult> {
    const ctx = await this.engine.createContext();
    try {
      const perception = createPerceptionEngine(ctx.cdp());
      const action = createActionEngine(ctx.cdp(), ctx, perception);

      const actionEvents = trace.events.filter((e): e is ActionEvent => e.kind === "action");
      const snapshotEvents = trace.events.filter((e): e is SnapshotEvent => e.kind === "snapshot");

      const snapshotDiffs: SnapshotDiff[] = [];
      let actionsReplayed = 0;
      let liveNodeCount = 0;
      const recordedNodeCount = snapshotEvents[snapshotEvents.length - 1]?.nodeCount ?? 0;

      for (const actionEvent of actionEvents) {
        try {
          await action.execute(actionEvent.command);
          actionsReplayed += 1;
        } catch {
          // Continue replay even if individual action fails (element may have changed)
        }
      }

      // Take final snapshot and diff against the last recorded snapshot
      const lastRecordedSnap = snapshotEvents[snapshotEvents.length - 1];
      if (lastRecordedSnap) {
        const liveSnap = (await perception.snapshot("L1")) as InteractionGraph;
        liveNodeCount = liveSnap.nodes.size;
        snapshotDiffs.push(diffSnapshots(lastRecordedSnap, liveSnap));
      }

      const diverged = snapshotDiffs.some(
        (d) => d.addedNodes > 0 || d.removedNodes > 0 || d.updatedNodes > 0,
      );

      return {
        traceId: trace.traceId,
        replayedAt: Date.now(),
        actionsReplayed,
        snapshotDiffs,
        liveSnapshotNodeCount: liveNodeCount,
        recordedSnapshotNodeCount: recordedNodeCount,
        diverged,
      };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
}
