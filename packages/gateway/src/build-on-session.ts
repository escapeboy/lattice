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

import type { ActionDetail, GrantFieldPreview, SecurityKernel } from "@lattice/kernel";
import type { EngineSession } from "@lattice/engine-adapter";
import { snapshotToIG, igDelta } from "@lattice/perception";
import type { SnapshotIG, IGDelta, NodeId, PerceptionCache, CacheResolution } from "@lattice/perception";
import { GovernedActuator, RecoveryExecutor, locateInIG } from "@lattice/action";
import type {
  ActionCommand,
  ActionDescriber,
  GovernedActionResult,
  ReAnchor,
  RateLimiterPort,
  RecoveryTarget,
  LadderResult,
} from "@lattice/action";

/** Field labels whose value must never appear in the operator preview. */
const SECRET_LABEL = /pass|secret|cvv|card|otp|\bpin\b|token|ssn|security code/i;

function humanAction(type: string, label: string | undefined, fieldCount: number): string {
  if (type === "submit") {
    return fieldCount > 0 ? `Submit form (${fieldCount} field${fieldCount === 1 ? "" : "s"})` : "Submit form";
  }
  if (type === "act") return label ? `Click '${label}'` : "Click control";
  return label ? `${type} '${label}'` : type;
}

export interface BuildOnSessionContext {
  readonly origin: string;
  readonly sessionId: string;
  /** Optional shared per-origin rate limiter (P1.2). */
  readonly rateLimiter?: RateLimiterPort;
  /** Optional shared per-origin perception cache (P2.2). */
  readonly cache?: PerceptionCache;
}

export class BuildOnSession {
  private lastIG: SnapshotIG | undefined;
  private lastResolution: CacheResolution | undefined;
  private readonly actuator: GovernedActuator;
  /**
   * The fields the AGENT filled on the current page — the data a subsequent
   * submit would send. Agent-supplied (never page content / vault secrets, which
   * never pass through here), so it is safe to preview; secret-labelled fields
   * are masked. Reset on navigation.
   */
  private readonly filled: GrantFieldPreview[] = [];

  constructor(
    private readonly engine: EngineSession,
    kernel: SecurityKernel,
    private readonly ctx: BuildOnSessionContext,
  ) {
    // Re-anchoring reads the LATEST perceived snapshot's ref map, so identity
    // resolution always tracks the current DOM even across re-renders.
    const anchor: ReAnchor = { refFor: (nodeId) => this.lastIG?.refMap.get(nodeId) };
    // Perception-aware enrichment for the approval panel: the actuator has no
    // labels/filled-field context; this session does.
    const describer: ActionDescriber = {
      describe: (command, effectiveType) => this.describeAction(command, effectiveType),
    };
    this.actuator = new GovernedActuator(engine, kernel, anchor, ctx, describer);
  }

  private labelFor(nodeId: NodeId): string | undefined {
    const label = this.lastIG?.graph.nodes.get(nodeId)?.label;
    return label && label.trim() ? label : undefined;
  }

  /** Build operator-facing detail for a consequential command (best-effort). */
  private describeAction(command: ActionCommand, effectiveType: string): ActionDetail | undefined {
    const targetLabel = "target" in command ? this.labelFor(command.target.nodeId) : undefined;
    const intent = "intent" in command ? command.intent : undefined;
    const fields = effectiveType === "submit" && this.filled.length ? this.filled.map((f) => ({ ...f })) : undefined;
    return {
      action: humanAction(effectiveType, targetLabel, this.filled.length),
      ...(targetLabel ? { targetLabel } : {}),
      ...(fields ? { fields } : {}),
      ...(intent ? { intent } : {}),
    };
  }

  /** Record an agent fill so a later submit can preview the form data. */
  private recordFilled(command: ActionCommand): void {
    if (command.type === "navigate") {
      this.filled.length = 0;
      return;
    }
    if (command.type !== "fill" && command.type !== "set") return;
    const label = this.labelFor(command.target.nodeId) ?? "field";
    const raw = command.type === "fill" ? command.value : String(command.value);
    const masked = SECRET_LABEL.test(label);
    this.filled.push({ label, value: masked ? "••••" : raw, masked });
  }

  /** Perceive the page as a taint-marked Lattice IG, refreshing the anchor. */
  async perceive(tier: "L1" | "L2" = "L1"): Promise<SnapshotIG> {
    const raw = await this.engine.snapshot({ interactive: tier === "L1" });
    this.lastIG = snapshotToIG(raw, { tier });
    // Per-origin cache (P2.2): record what is new/changed vs what this origin has
    // already delivered. The cache stores page-origin nodes and is NOT a taint
    // bypass — taint is reasserted at the gateway boundary on delivery.
    if (this.ctx.cache) this.lastResolution = this.ctx.cache.resolve(this.ctx.origin, this.lastIG.graph);
    return this.lastIG;
  }

  /**
   * The per-origin cache resolution for the last perceive (P2.2), or undefined if
   * no cache is wired. A cache-aware gateway ships `sentNodes`/`removedIds`
   * instead of the full node set on a warm revisit.
   */
  get cacheResolution(): CacheResolution | undefined {
    return this.lastResolution;
  }

  /** Gate + execute a semantic action. Auto-perceives once if no anchor exists. */
  async act(command: ActionCommand): Promise<GovernedActionResult> {
    if (!this.lastIG && command.type !== "navigate") await this.perceive();
    const result = await this.actuator.execute(command);
    // Track the submitted-data preview only after the action succeeds (execute
    // throws on failure), so the panel reflects what was actually entered.
    this.recordFilled(command);
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
