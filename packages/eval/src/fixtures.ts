/**
 * Load captured agent-browser snapshots (real `snapshot -i --json` envelopes,
 * recorded against live Chrome and committed under fixtures/). Replaying real
 * captures keeps the eval deterministic and CI-runnable while measuring genuine
 * engine output, not synthetic mock data.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawSnapshot } from "@lattice/engine-adapter";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface Frame {
  /** agent-browser ref id → {name, role} — the bare-engine view. */
  readonly refs: Record<string, { name?: string; role?: string }>;
  /** agent-browser's terse accessibility text (what a bare agent feeds an LLM). */
  readonly snapshotText: string;
  /** The same snapshot as a Lattice RawSnapshot (input to snapshotToIG). */
  readonly raw: RawSnapshot;
}

export function loadFrame(file: string): Frame {
  const env = JSON.parse(readFileSync(FIXTURES_DIR + file, "utf8")) as {
    data: { refs: Record<string, { name?: string; role?: string }>; snapshot: string; origin?: string };
  };
  const d = env.data;
  return {
    refs: d.refs,
    snapshotText: d.snapshot,
    raw: { url: d.origin ?? "data:eval", refs: [], tree: d.snapshot },
  };
}

/** Find the agent-browser ref whose accessible name equals `label`, or null. */
export function refByLabel(frame: Frame, label: string): string | null {
  for (const [ref, v] of Object.entries(frame.refs)) {
    if (v.name === label) return ref;
  }
  return null;
}
