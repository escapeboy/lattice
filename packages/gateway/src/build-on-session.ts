/**
 * BuildOnSession (ADR 0002) — the governed session that composes the four
 * build-on layers into the unit the agent-facing gateway drives:
 *
 *   agent-browser engine (hands/eyes)  ──┐
 *   snapshotToIG (stable id + taint)   ──┼─→ BuildOnSession ──→ MCP gateway → agent
 *   GovernedActuator (kernel gating)   ──┤
 *   SecurityKernel (the constitution)  ──┘
 *
 * The agent never holds the engine. It calls the gateway, which calls this
 * session, which perceives (taint-marked IG), re-anchors stable NodeIds to the
 * engine's current refs, and gates every action through the kernel. The engine's
 * kernel-bypass primitives are unreachable from here by construction.
 */

import type { SecurityKernel } from "@lattice/kernel";
import type { EngineSession } from "@lattice/engine-adapter";
import { snapshotToIG, igDelta } from "@lattice/perception";
import type { SnapshotIG, IGDelta } from "@lattice/perception";
import { GovernedActuator, RecoveryExecutor, locateInIG } from "@lattice/action";
import type {
  ActionCommand,
  GovernedActionResult,
  ReAnchor,
  RateLimiterPort,
  RecoveryTarget,
  LadderResult,
} from "@lattice/action";

export interface BuildOnSessionContext {
  readonly origin: string;
  readonly sessionId: string;
  /** Optional shared per-origin rate limiter (P1.2). */
  readonly rateLimiter?: RateLimiterPort;
}

export class BuildOnSession {
  private lastIG: SnapshotIG | undefined;
  private readonly actuator: GovernedActuator;

  constructor(
    private readonly engine: EngineSession,
    kernel: SecurityKernel,
    private readonly ctx: BuildOnSessionContext,
  ) {
    // Re-anchoring reads the LATEST perceived snapshot's ref map, so identity
    // resolution always tracks the current DOM even across re-renders.
    const anchor: ReAnchor = { refFor: (nodeId) => this.lastIG?.refMap.get(nodeId) };
    this.actuator = new GovernedActuator(engine, kernel, anchor, ctx);
  }

  /** Perceive the page as a taint-marked Lattice IG, refreshing the anchor. */
  async perceive(tier: "L1" | "L2" = "L1"): Promise<SnapshotIG> {
    const raw = await this.engine.snapshot({ interactive: tier === "L1" });
    this.lastIG = snapshotToIG(raw, { tier });
    return this.lastIG;
  }

  /** Gate + execute a semantic action. Auto-perceives once if no anchor exists. */
  async act(command: ActionCommand): Promise<GovernedActionResult> {
    if (!this.lastIG && command.type !== "navigate") await this.perceive();
    const result = await this.actuator.execute(command);
    return result;
  }

  /**
   * Bounded failure recovery for a lost target (P2.1). The session performs the
   * AUTONOMOUS rungs — re-perceive and re-anchor (rung 1), then an alternative
   * role+attribute locator (rung 2). The L3-vision and handoff rungs need a model
   * / human, so they are injected; defaults make them no-ops (the session does
   * what it can and escalates). Single-pass by construction — never a retry loop.
   */
  async recover(
    target: RecoveryTarget,
    reason: string,
    escalate: {
      l3Locate?: (target: RecoveryTarget) => Promise<boolean>;
      handoff?: (target: RecoveryTarget, reason: string) => Promise<void>;
    } = {},
  ): Promise<LadderResult> {
    const executor = new RecoveryExecutor({
      relocate: async (t) => {
        const ig = await this.perceive();
        const nodes = [...ig.graph.nodes.values()].map((n) => ({
          id: n.id,
          role: n.role,
          label: n.label,
          ...(n.value !== undefined ? { value: n.value } : {}),
          ...(n.href !== undefined ? { href: n.href } : {}),
        }));
        return locateInIG(t, nodes, (id) => ig.refMap.get(id));
      },
      l3Locate: escalate.l3Locate ?? (() => Promise.resolve(false)),
      handoff: escalate.handoff ?? (() => Promise.resolve()),
    });
    return executor.recover(target, reason);
  }

  /** Stable-id delta between two perceived snapshots (delta streaming basis). */
  delta(prev: SnapshotIG, next: SnapshotIG): IGDelta {
    return igDelta(prev.graph, next.graph);
  }

  get origin(): string {
    return this.ctx.origin;
  }
}
