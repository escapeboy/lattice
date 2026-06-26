/**
 * Dual-stack adapters (ADR 0002, S6): make the build-on stack satisfy the SAME
 * PerceptionEngine / ActionEngine contracts the gateway already consumes, so
 * server.ts drives either engine unchanged. CDP stays the default; the build-on
 * path is selected explicitly until it reaches parity.
 *
 * Both adapters wrap ONE shared BuildOnSession so re-anchoring stays consistent:
 * the action adapter perceives (refreshing the anchor) before acting.
 */

import type {
  FidelityTier,
  IGDelta,
  InteractionGraph,
  L0Summary,
  PerceptionEngine,
  PerceptionSnapshot,
} from "@lattice/perception";
import { igDelta } from "@lattice/perception";
import type { ActionCommand, ActionEngine, ActionResult } from "@lattice/action";
import type { BuildOnSession } from "./build-on-session.js";

const INTERACTIVE = new Set(["button", "link", "input", "select", "textarea", "checkbox", "radio", "combobox"]);

export class BuildOnPerceptionAdapter implements PerceptionEngine {
  constructor(private readonly session: BuildOnSession) {}

  async snapshot(tier: FidelityTier): Promise<PerceptionSnapshot> {
    // L2/L3 keep all roles; L1/L0 use the interactive snapshot. (No pixels: L3
    // degrades to L2, matching the CDP engine's P0 behaviour.)
    const ig = await this.session.perceive(tier === "L2" || tier === "L3" ? "L2" : "L1");
    const graph = ig.graph;
    if (tier === "L0") {
      const nodes = [...graph.nodes.values()];
      const summary: L0Summary = {
        tier: "L0",
        url: graph.url,
        title: graph.title,
        interactiveCount: nodes.filter((n) => INTERACTIVE.has(n.role)).length,
        landmarkCount: nodes.filter((n) => n.role === "landmark").length,
      };
      return summary;
    }
    return graph;
  }

  delta(prev: InteractionGraph, next: InteractionGraph): IGDelta {
    return igDelta(prev, next);
  }
}

export class BuildOnActionAdapter implements ActionEngine {
  constructor(
    private readonly session: BuildOnSession,
    private readonly perception: BuildOnPerceptionAdapter,
  ) {}

  async execute(command: ActionCommand): Promise<ActionResult> {
    // Ground-truth delta: perceive before, act (kernel-gated, re-anchored),
    // perceive after. The before-perceive also refreshes the re-anchor.
    const prev = (await this.perception.snapshot("L1")) as InteractionGraph;
    const result = await this.session.act(command); // throws ActionError when gated/failed
    const next = (await this.perception.snapshot("L1")) as InteractionGraph;

    return {
      success: result.ok,
      delta: igDelta(prev, next),
      url: result.url ?? next.url,
      ...(result.extracted !== undefined ? { extracted: result.extracted } : {}),
    };
  }
}
