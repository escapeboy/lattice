/**
 * S3 build-on action (ADR 0002): route every semantic action through the
 * Security Kernel BEFORE it reaches the agent-browser engine.
 *
 * The actuator speaks Lattice's NodeId-addressed vocabulary. For each command it:
 *   1. classifies + gates via the kernel (read/benign auto-grant; consequential
 *      needs a human grant; prohibited refused) — the gate is the real boundary;
 *   2. re-anchors the stable NodeId to the engine's CURRENT volatile ref;
 *   3. executes via the narrow SemanticEngine surface.
 *
 * eval / raw CDP / file access are unreachable here by construction: there is no
 * ActionCommand that expresses them, and the engine firewall would refuse them
 * anyway. File-bearing verbs (upload/download) are routed to a typed refusal
 * rather than a file path into the engine.
 */

import type { SecurityKernel } from "@lattice/kernel";
import type { EngineSession, Locator, SemanticAction } from "@lattice/engine-adapter";
import type { NodeId } from "@lattice/perception";
import { ActionError } from "./types.js";
import type { ActionCommand } from "./types.js";

/** Re-anchoring source: maps a stable NodeId to the current snapshot's ref. */
export interface ReAnchor {
  refFor(nodeId: NodeId): string | undefined;
}

export interface GovernedActionResult {
  readonly ok: boolean;
  readonly url: string | undefined;
  /** Extracted text, for the `extract` verb. */
  readonly extracted?: string;
  /**
   * For `navigate`: `false` when the page did not settle within the bounded
   * budget (continuous-render canvas / infinite-scroll / polling). The action
   * SUCCEEDED (no hang, no throw) but perception should escalate to L3/screenshot.
   * Omitted on a normal settled navigation and on non-navigate actions.
   */
  readonly settled?: boolean;
}

/**
 * Per-origin throttle (P1.2). Structural port so the action package need not
 * depend on @lattice/runtime; `OriginRateLimiter` satisfies it. Shared across
 * sessions so a fan-out against one origin respects the limit collectively.
 */
export interface RateLimiterPort {
  acquire(url: string): Promise<void>;
  report(url: string, status: number): void;
}

export interface ActuatorContext {
  /** Origin the task is scoped to (for kernel classification/egress). */
  readonly origin: string;
  readonly sessionId: string;
  /** Optional shared per-origin rate limiter; navigations acquire a slot first. */
  readonly rateLimiter?: RateLimiterPort;
}

export class GovernedActuator {
  constructor(
    private readonly engine: EngineSession,
    private readonly kernel: SecurityKernel,
    private readonly anchor: ReAnchor,
    private readonly ctx: ActuatorContext,
  ) {}

  async execute(command: ActionCommand): Promise<GovernedActionResult> {
    // 1. Gate. Navigation is scope-checked; everything else is classified and
    //    requires a grant when consequential.
    if (command.type === "navigate") {
      if (!this.kernel.checkNavigation(command.url)) {
        throw new ActionError("navigation_interrupted", "re-perceive", `origin_out_of_scope: ${command.url}`);
      }
      // Politeness: wait for a per-origin slot before hitting the site (P1.2).
      await this.ctx.rateLimiter?.acquire(command.url);
      const res = await this.engine.navigate(command.url);
      // Bounded settle: a non-quiescing page resolves not-settled rather than
      // hanging/throwing. Surface that so perception escalates to L3 — the nav
      // itself is NOT a failure, so it is NOT a navigation_interrupted (which
      // would drive the agent into a re-perceive retry loop on a page that will
      // never quiesce). Single-pass by construction; no retry here.
      return { ok: true, url: res.url, ...(res.settled === false ? { settled: false } : {}) };
    }

    const decision = await this.kernel.requestGrant({
      actionType: command.type,
      origin: this.ctx.origin,
      sessionId: this.ctx.sessionId,
      payload: command,
    });
    if (!decision.granted) {
      throw new ActionError("prohibited", "human-grant-required", decision.reason ?? "blocked by policy");
    }

    // extract is read-tier: no engine action, just read the page text.
    if (command.type === "extract") {
      const text = await this.engine.readText();
      const url = await this.engine.currentUrl().catch(() => undefined);
      return { ok: true, url, extracted: text };
    }

    // 2 + 3. Re-anchor and execute.
    const result = await this.engine.act(this.toSemanticAction(command));
    if (!result.ok) {
      throw new ActionError(mapEngineError(result.error), "re-perceive", result.error ?? "action failed");
    }
    return { ok: true, url: result.url };
  }

  /** Resolve a command's target NodeId to the engine's current ref, or fail typed. */
  private locator(nodeId: NodeId): Locator {
    const ref = this.anchor.refFor(nodeId);
    if (!ref) {
      throw new ActionError("element_gone", "re-perceive", `no live ref for node ${nodeId}`);
    }
    return { kind: "ref", ref };
  }

  private toSemanticAction(
    command: Exclude<ActionCommand, { type: "navigate" } | { type: "extract" }>,
  ): SemanticAction {
    switch (command.type) {
      case "act":
        return { type: "click", target: this.locator(command.target.nodeId) };
      case "fill":
        return { type: "fill", target: this.locator(command.target.nodeId), value: command.value };
      case "select":
        return { type: "select", target: this.locator(command.target.nodeId), values: [command.value] };
      case "set":
        return { type: "fill", target: this.locator(command.target.nodeId), value: String(command.value) };
      case "submit":
        return { type: "submit", target: this.locator(command.target.nodeId) };
      case "scroll_to":
        return { type: "scrollIntoView", target: this.locator(command.target.nodeId) };
      case "wait_for":
        return { type: "wait", ms: command.condition.timeoutMs ?? 1000 };
      case "upload":
      case "download":
        // File-bearing verbs never receive a file path into the engine — that is
        // the file-access surface the firewall closes. If the kernel ever grants
        // them, they still refuse here.
        throw new ActionError("prohibited", undefined, `${command.type} is firewalled (no file access to the engine)`);
    }
  }
}

function mapEngineError(error: string | undefined): ConstructorParameters<typeof ActionError>[0] {
  const e = (error ?? "").toLowerCase();
  if (e.includes("not found") || e.includes("no element")) return "element_not_found";
  if (e.includes("disabled")) return "disabled";
  if (e.includes("timeout")) return "timeout";
  if (e.includes("navigation")) return "navigation_interrupted";
  return "element_gone";
}
