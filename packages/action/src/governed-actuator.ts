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

import type { ActionDetail, EffectEvidence, SecurityKernel } from "@lattice/kernel";
import type { EngineSession, Locator, SemanticAction } from "@lattice/engine-adapter";
import type { NodeId } from "@lattice/perception";
import { collectEngineEvidence, type PerceivedNode } from "./engine-evidence.js";
import { guardContext, guardDiff, targetGuard, type TargetGuard } from "./target-guard.js";
import { ActionError } from "./types.js";
import type { ActionCommand } from "./types.js";

/**
 * Assembles operator-facing detail for a consequential command. Injected by the
 * governed session, which HAS the perception context (labels, filled fields) the
 * actuator does not. Returns undefined when there is nothing useful to add.
 */
export interface ActionDescriber {
  /** `context` is page text next to the target, so the human can tell rows apart. */
  describe(command: ActionCommand, effectiveType: string, context?: string): ActionDetail | undefined;
}

/** Re-anchoring source: maps a stable NodeId to the current snapshot's ref. */
export interface ReAnchor {
  refFor(nodeId: NodeId): string | undefined;
  /**
   * The perceived node behind this id (role / label / href), when the caller
   * holds an Interaction Graph. Feeds the effect gate: the label is the single
   * richest signal and the engine seam has no way to read an accessible name.
   * Optional — its absence costs precision, never safety, because an unknown
   * target classifies as consequential.
   */
  nodeFor?(nodeId: NodeId): PerceivedNode | undefined;
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
  /**
   * Whether the network backstop covered this action. Present on every
   * auto-granted action that touched the page, so "no escalation happened" can
   * be told apart from "nothing was watching".
   */
  readonly backstop?: BackstopState;
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

/**
 * Optional robots.txt navigation gate (borrowed from Lightpanda's
 * `--obey-robots`). `@lattice/robots`' RobotsChecker satisfies it; the serve
 * wiring injects one when `LATTICE_OBEY_ROBOTS` is set. Structural port so the
 * action package need not depend on @lattice/robots.
 */
export interface RobotsCheckerPort {
  /** Resolve whether the configured product token may fetch `url`. */
  allowed(url: string): Promise<boolean>;
}

/**
 * Network backstop port. `EffectBackstop` (CDP) satisfies it; structural so the
 * action package does not depend on a transport.
 *
 * It exists because the static classifier has one blind spot it cannot close:
 * a control that reads benign on every DOM signal and POSTs from JavaScript.
 * The evidence only exists after the click, so something has to watch the wire.
 */
export interface EffectBackstopPort {
  /** Begin holding requests attributable to the action about to be dispatched. */
  arm(frameId?: string): Promise<void>;
  /** Stop holding. */
  disarm(): Promise<void>;
}

/** Why the backstop did not run for an action. Carried on the result. */
export type BackstopState = "armed" | "disabled" | "unavailable";

export interface ActuatorContext {
  /** Origin the task is scoped to (for kernel classification/egress). */
  readonly origin: string;
  readonly sessionId: string;
  /** Optional shared per-origin rate limiter; navigations acquire a slot first. */
  readonly rateLimiter?: RateLimiterPort;
  /** Optional robots.txt gate; when present, a disallowed navigation is refused. */
  readonly robots?: RobotsCheckerPort;
  /**
   * Network backstop. ON by default: when a port is supplied it is armed around
   * every auto-granted action, with no opt-in.
   *
   * When NO port is supplied the actuator cannot watch the wire, and it says so
   * on every result (`backstop: "unavailable"`) rather than reporting a
   * protection it does not have. That is the state on the build-on engine seam
   * today: agent-browser's `network` primitive is firewalled and the egress
   * proxy sees only `CONNECT host:port` over HTTPS, so neither can supply the
   * method, body or initiator this needs.
   */
  readonly backstop?: EffectBackstopPort;
  /** Explicitly turn the backstop off. A deliberate, recorded choice. */
  readonly backstopDisabled?: boolean;
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
      // Politeness: honor the target origin's robots.txt when obey-robots is
      // wired (opt-in). A disallowed URL is a terminal refusal — `prohibited`,
      // NOT navigation_interrupted, so the agent does not spin in a re-perceive
      // retry loop over a page it will never be allowed to fetch. The robots
      // fetch itself rides the injected (governed) transport.
      if (this.ctx.robots && !(await this.ctx.robots.allowed(command.url))) {
        throw new ActionError("prohibited", undefined, `robots_disallowed: ${command.url}`);
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

    // Liveness before governance: a NodeId with no live ref is a stale
    // perception, not a policy question. Gating it first would report a
    // re-perceivable staleness as a policy refusal.
    if ("target" in command && this.anchor.refFor(command.target.nodeId) === undefined) {
      throw new ActionError("element_gone", "re-perceive", `no live ref for node ${command.target.nodeId}`);
    }

    // Effect-based classification. The verb the agent chose must NOT decide
    // consequentiality — the target does. The engine compiles `submit` and a
    // click on the submit control to the SAME operation (`click @ref`), so
    // gating on the verb let an agent dodge the human grant by sending `act`.
    // Evidence about the target is collected FIRST and handed to the kernel, so
    // there is no path where the gate runs without it.
    const evidence = await this.evidenceFor(command);
    const actionType =
      command.type === "act" && evidence?.submitControl === true ? "submit" : command.type;

    const base = {
      actionType,
      origin: this.ctx.origin,
      sessionId: this.ctx.sessionId,
      payload: command,
      ...(evidence ? { effect: evidence } : {}),
    };
    // Classify once so the result can tell the agent WHETHER this passed a human
    // grant. `consequential` → the grant was a human approval (gated); read/benign
    // → an auto-grant (not gated). Same request the gate classifies internally.
    const policyClass = this.kernel.classify(base);
    // A human grant is for the control the human was shown. Pin it now and
    // check it again after the wait, which can outlast a re-render.
    const pinned =
      policyClass === "consequential" && "target" in command
        ? await this.pinTarget(command.target.nodeId)
        : undefined;
    const detail = this.describer?.describe(command, actionType, pinned && guardContext(pinned));
    const request = { ...base, ...(detail ? { detail } : {}) };
    const decision = await this.kernel.requestGrant(request);
    if (!decision.granted) {
      throw new ActionError("prohibited", "human-grant-required", decision.reason ?? "blocked by policy");
    }
    if (pinned && "target" in command) {
      const now = await this.guardFor(command.target.nodeId);
      const changed = guardDiff(pinned, now);
      if (changed.length > 0) {
        throw new ActionError(
          "element_gone",
          "re-perceive",
          `target changed while waiting for approval (${changed.join(", ")}); the approved action was not performed`,
        );
      }
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

    // 2 + 3. Re-anchor and execute, with the backstop armed.
    //
    // Only for an AUTO-GRANTED action: a consequential one already carries its
    // human grant, and asking again for the request it obviously makes would be
    // a second prompt for the same decision. The window opens BEFORE dispatch,
    // because interception only affects requests started after it takes effect.
    const backstopState = this.backstopState(policyClass);
    if (backstopState === "armed") await this.ctx.backstop!.arm();
    try {
      const result = await this.engine.act(this.toSemanticAction(command));
      if (!result.ok) {
        throw new ActionError(mapEngineError(result.error), "re-perceive", result.error ?? "action failed");
      }
      return { ok: true, url: result.url, ...meta, backstop: backstopState };
    } finally {
      if (backstopState === "armed") await this.ctx.backstop!.disarm().catch(() => undefined);
    }
  }

  /**
   * Whether to arm for this action.
   *
   * Only an AUTO-GRANTED action is watched. A consequential one already passed
   * a human, and holding the request it obviously makes would ask the same
   * person the same question twice — the fastest way to get a gate turned off.
   *
   * `unavailable` is reported rather than silently treated as "fine": a gate
   * that cannot see the wire should say so.
   */
  private backstopState(policyClass: string): BackstopState {
    if (policyClass !== "read" && policyClass !== "benign") return "disabled";
    if (this.ctx.backstopDisabled === true) return "disabled";
    return this.ctx.backstop ? "armed" : "unavailable";
  }

  /**
   * Deterministic facts about the command's target, for the kernel's effect
   * classification. `undefined` only for commands with no element target — the
   * kernel classifies those on the verb alone. For a targeted command this
   * ALWAYS returns evidence, even if every field is unknown, because "no
   * evidence" is itself the signal that makes the action consequential.
   */
  private async evidenceFor(command: ActionCommand): Promise<EffectEvidence | undefined> {
    if (!("target" in command)) return undefined;
    const nodeId = command.target.nodeId;
    return collectEngineEvidence(this.engine, this.anchor.refFor(nodeId), this.anchor.nodeFor?.(nodeId));
  }

  /**
   * The guard the human approves against. It must describe the control the
   * agent perceived: if the label moved on since then, the approval panel would
   * name one control while the click hits another.
   */
  private async pinTarget(nodeId: NodeId): Promise<TargetGuard> {
    const guard = await this.guardFor(nodeId);
    const perceived = this.anchor.nodeFor?.(nodeId)?.label;
    if (perceived !== undefined && perceived !== guard.name) {
      throw new ActionError(
        "element_gone",
        "re-perceive",
        `target changed since it was perceived ('${perceived}' is now '${guard.name}')`,
      );
    }
    return guard;
  }

  private async guardFor(nodeId: NodeId): Promise<TargetGuard> {
    const ref = this.anchor.refFor(nodeId);
    const raw = ref ? await this.engine.snapshot({ interactive: false }) : undefined;
    const guard = ref && raw ? targetGuard(raw.tree, ref) : undefined;
    if (!guard) throw new ActionError("element_gone", "re-perceive", `no live ref for node ${nodeId}`);
    return guard;
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
