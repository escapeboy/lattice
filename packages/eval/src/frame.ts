/**
 * The unit every system is measured on: one perceive point, in all four
 * representations, derived from the SAME page. Fixtures and the synthetic flow
 * both produce these, so the four systems are compared apples-to-apples.
 */

import type { RawSnapshot } from "@lattice/engine-adapter";

export interface EvalFrame {
  /** agent-browser ref id → {name, role} — the bare-engine view. */
  readonly refs: Record<string, { name?: string; role?: string }>;
  /** agent-browser's terse a11y text (what a bare semantic agent feeds an LLM). */
  readonly snapshotText: string;
  /** The same snapshot as a Lattice RawSnapshot (input to snapshotToIG). */
  readonly raw: RawSnapshot;
  /** Serialized DOM (what a raw-DOM "Chrome method" agent feeds an LLM). */
  readonly html: string;
}

/**
 * Vision-token cost of one screenshot. Anthropic estimates image tokens as
 * roughly (width × height) / 750. We model a single 1280×800 viewport capture —
 * the CHEAPEST honest case (no full-page scroll stitching) so the screenshot
 * baseline is not strawmanned. A screenshot cannot be cheaply diffed for the
 * model, so this cost is paid in full at every perceive step.
 */
export const SCREENSHOT_VIEWPORT = { width: 1280, height: 800 } as const;
export const SCREENSHOT_TOKENS = Math.ceil((SCREENSHOT_VIEWPORT.width * SCREENSHOT_VIEWPORT.height) / 750);

/** Find the agent-browser ref whose accessible name equals `label`, or null. */
export function refByLabel(frame: EvalFrame, label: string): string | null {
  for (const [ref, v] of Object.entries(frame.refs)) {
    if (v.name === label) return ref;
  }
  return null;
}
