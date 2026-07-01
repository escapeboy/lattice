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

import type { ActionDetail, SecurityKernel } from "@lattice/kernel";
import type { EngineSession, Locator, SemanticAction } from "@lattice/engine-adapter";
import type { NodeId } from "@lattice/perception";
import { ActionError } from "./types.js";
import type { ActionCommand } from "./types.js";

/**
 * Assembles operator-facing detail for a consequential command. Injected by the
 * governed session, which HAS the perception context (labels, filled fields) the
 * actuator does not. Returns undefined when there is nothing useful to add.
 */
export interface ActionDescriber {
  describe(command: ActionCommand, effectiveType: string): ActionDetail | undefined;
}

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
  /**
   * Governance metadata (ADDITIVE). `gated` is true when the action passed a
   * HUMAN grant (consequential); false for a benign/read auto-grant. On a gated
   * action, `grantId` (an opaque handle — not a secret) and `policyClass` are
   * also carried, so an approved consequential action is legible to the agent
   * rather than indistinguishable from an ungated one. A denial stays a typed
   * ActionError (thrown), unchanged.
   */
  readonly gated?: boolean;
  readonly grantId?: string;
  readonly policyClass?: string;
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
    /** Optional perception-aware enrichment for the approval panel. */
    private readonly describer?: ActionDescriber,
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

    // Effect-based classification (close the verb-name gate bypass). The engine
    // compiles `submit` and a click on the submit control to the SAME operation
    // (`click @ref`), so an agent could dodge the consequential gate by sending
    // `act` (click) on a submit button instead of `submit`. The verb the agent
    // chose must NOT decide consequentiality — the target does. A click on an
    // explicit submit control is a form submission, so classify it as `submit`
    // and route it through the same human grant.
    const actionType =
      command.type === "act" && (await this.isSubmitControl(command.target.nodeId))
        ? "submit"
        : command.type;

    const detail = this.describer?.describe(command, actionType);
    const request = {
      actionType,
      origin: this.ctx.origin,
      sessionId: this.ctx.sessionId,
      payload: command,
      ...(detail ? { detail } : {}),
    };
    // Classify once so the result can tell the agent WHETHER this passed a human
    // grant. `consequential` → the grant was a human approval (gated); read/benign
    // → an auto-grant (not gated). Same request the gate classifies internally.
    const policyClass = this.kernel.classify(request);
    const decision = await this.kernel.requestGrant(request);
    if (!decision.granted) {
      throw new ActionError("prohibited", "human-grant-required", decision.reason ?? "blocked by policy");
    }
    // Additive governance metadata: a human-approved consequential action carries
    // gated:true + the opaque grantId + policyClass, so it is distinguishable from
    // an ungated benign action (which carries gated:false and no grantId).
    const meta: Pick<GovernedActionResult, "gated" | "grantId" | "policyClass"> =
      policyClass === "consequential"
        ? { gated: true, policyClass, ...(decision.grantId ? { grantId: decision.grantId } : {}) }
        : { gated: false };

    // extract is read-tier: no engine action, just read the page text.
    if (command.type === "extract") {
      const text = await this.engine.readText();
      const url = await this.engine.currentUrl().catch(() => undefined);
      return { ok: true, url, extracted: text, ...meta };
    }

    // 2 + 3. Re-anchor and execute.
    const result = await this.engine.act(this.toSemanticAction(command));
    if (!result.ok) {
      throw new ActionError(mapEngineError(result.error), "re-perceive", result.error ?? "action failed");
    }
    return { ok: true, url: result.url, ...meta };
  }

  /**
   * True when the click target is an EXPLICIT submit control — `<input
   * type=submit|image>` or `<button type=submit>`. Read via the engine's
   * non-eval `get attr` probe; absent/undetectable → false. A bare `<button>`
   * whose DEFAULT type is submit is NOT caught (that needs DOM/form
   * introspection the engine firewall forbids) — a documented residual, far
   * narrower than gating on the verb name alone. Degrades to false when the
   * engine has no `getAttr` (test/CDP fakes) — the verb classification still
   * gates an explicit `submit`.
   */
  private async isSubmitControl(nodeId: NodeId): Promise<boolean> {
    if (!this.engine.getAttr) return false;
    const ref = this.anchor.refFor(nodeId);
    if (!ref) return false; // stale node — locator() raises element_gone downstream
    const type = (await this.engine.getAttr(ref, "type").catch(() => undefined))?.toLowerCase();
    return type === "submit" || type === "image";
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
