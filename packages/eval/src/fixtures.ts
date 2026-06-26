/**
 * Load captured agent-browser snapshots (real `snapshot -i --json` envelopes,
 * recorded against live Chrome and committed under fixtures/). Replaying real
 * captures keeps the eval deterministic and CI-runnable while measuring genuine
 * engine output, not synthetic mock data. The raw-DOM baseline is recovered from
 * the capture's own `data:text/html,...` origin, so it is the real source HTML.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EvalFrame } from "./frame.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Recover the source HTML from a `data:text/html,<...>` origin, or "" if none. */
function htmlFromOrigin(origin: string | undefined): string {
  if (!origin || !origin.startsWith("data:text/html,")) return "";
  const body = origin.slice("data:text/html,".length);
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

export function loadFrame(file: string): EvalFrame {
  const env = JSON.parse(readFileSync(FIXTURES_DIR + file, "utf8")) as {
    data: { refs: Record<string, { name?: string; role?: string }>; snapshot: string; origin?: string };
  };
  const d = env.data;
  return {
    refs: d.refs,
    snapshotText: d.snapshot,
    raw: { url: d.origin ?? "data:eval", refs: [], tree: d.snapshot },
    html: htmlFromOrigin(d.origin),
  };
}

export { refByLabel } from "./frame.js";
export type { EvalFrame } from "./frame.js";
/** @deprecated use EvalFrame */
export type Frame = EvalFrame;
