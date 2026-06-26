/**
 * SecurityKernelImpl — enforces the trust boundary between agent and page content.
 *
 * Policy classification (per architecture):
 *   read            — perceive / extract only, no side effects
 *   benign          — navigation, scroll, non-consequential interactions
 *   consequential   — submit, form post, payment, delete, ACL change
 *   prohibited      — CAPTCHA, account creation, hard delete, ACL mutation
 *
 * Egress firewall: destination proposed by page content is blocked by default.
 * A destination is allowed only if it matches the task origin or the explicit allowlist.
 */

import { randomUUID } from "node:crypto";
import { taint } from "./types.js";
import { CONSTITUTIONAL_FLOOR, OperatorGate } from "./operator.js";
import type {
  AuditEvent,
  CapabilityRequest,
  EgressRequest,
  GrantDecision,
  GrantScope,
  KernelConfig,
  OperatorDecision,
  OperatorRequest,
  OperatorTier,
  PolicyClass,
  SecurityKernel,
  TaintedStr,
} from "./types.js";

// Default prohibited action prefixes — never allowed regardless of config
const ALWAYS_PROHIBITED = new Set([
  "captcha",
  "account.create",
  "acl.change",
  "permission.change",
  "hard_delete",
  "transfer",
  "payment",
]);

// Action types that are consequential by default
const CONSEQUENTIAL_DEFAULTS = new Set([
  "submit",
  "form.submit",
  "download",
  "upload",
  "delete",
  "checkout",
  "purchase",
  "send_email",
  "send_message",
]);

// Action types that are read-only by default
const READ_DEFAULTS = new Set([
  "extract",
  "perceive",
  "snapshot",
]);

// Action types that are benign by default
const BENIGN_DEFAULTS = new Set([
  "navigate",
  "scroll_to",
  "act",
  "wait_for",
  "fill",
]);

export class SecurityKernelImpl implements SecurityKernel {
  private readonly log: AuditEvent[] = [];
  private readonly operator = new OperatorGate();

  constructor(private readonly config: KernelConfig) {}

  classify(request: CapabilityRequest): PolicyClass {
    const { actionType } = request;
    const lower = actionType.toLowerCase();

    // Check prohibited first (highest priority)
    for (const p of this.config.prohibitedActions) {
      if (lower === p.toLowerCase() || lower.startsWith(p.toLowerCase())) {
        return "prohibited";
      }
    }
    for (const p of ALWAYS_PROHIBITED) {
      if (lower === p || lower.startsWith(p)) return "prohibited";
    }

    // Read-only
    for (const r of READ_DEFAULTS) {
      if (lower === r || lower.startsWith(r)) return "read";
    }

    // Consequential
    for (const c of CONSEQUENTIAL_DEFAULTS) {
      if (lower === c || lower.startsWith(c)) return "consequential";
    }

    // Benign
    for (const b of BENIGN_DEFAULTS) {
      if (lower === b || lower.startsWith(b)) return "benign";
    }

    // Default to benign for unknown interactive actions
    return "benign";
  }

  async requestGrant(request: CapabilityRequest): Promise<GrantDecision> {
    const policyClass = this.classify(request);

    if (policyClass === "prohibited") {
      const decision: GrantDecision = {
        granted: false,
        reason: `Action ${request.actionType} is prohibited`,
      };
      this.emit({
        kind: "prohibited",
        origin: request.origin,
        sessionId: request.sessionId,
        detail: `prohibited action: ${request.actionType}`,
        granted: false,
      });
      return decision;
    }

    if (policyClass === "read" || policyClass === "benign") {
      const decision: GrantDecision = {
        granted: true,
        grantId: randomUUID(),
        reason: `auto-granted: ${policyClass}`,
      };
      this.emit({
        kind: "grant",
        origin: request.origin,
        sessionId: request.sessionId,
        detail: `auto-grant (${policyClass}): ${request.actionType}`,
        granted: true,
      });
      return decision;
    }

    // Consequential — requires human grant
    if (this.config.grantHandler) {
      const decision = await this.config.grantHandler(request);
      this.emit({
        kind: "grant",
        origin: request.origin,
        sessionId: request.sessionId,
        detail: `human-grant (${decision.granted ? "approved" : "denied"}): ${request.actionType}`,
        granted: decision.granted,
      });
      return decision;
    }

    // No handler configured → deny by default
    const decision: GrantDecision = {
      granted: false,
      reason: "Consequential action requires a configured grantHandler",
    };
    this.emit({
      kind: "grant",
      origin: request.origin,
      sessionId: request.sessionId,
      detail: `auto-denied (no handler): ${request.actionType}`,
      granted: false,
    });
    return decision;
  }

  checkNavigation(targetUrl: string): boolean {
    // Empty allowlist = unrestricted (dev default). Schemeless contexts
    // (data:, about:, blank) carry no origin and are always allowed.
    if (this.config.allowedOrigins.length === 0) return true;
    let allowed: boolean;
    try {
      const u = new URL(targetUrl);
      if (u.protocol === "data:" || u.protocol === "about:") {
        allowed = true;
      } else {
        allowed = this.config.allowedOrigins.includes(u.origin);
      }
    } catch {
      allowed = false;
    }
    this.emit({
      kind: "policy",
      origin: "task",
      sessionId: "navigation",
      detail: `navigation ${allowed ? "in-scope" : "blocked (out-of-scope)"}: ${targetUrl.slice(0, 80)}`,
      granted: allowed,
    });
    return allowed;
  }

  checkEgress(req: EgressRequest): boolean {
    let allowed: boolean;
    try {
      const dest = new URL(req.destination);
      const destOrigin = dest.origin;
      const taskOrigin = req.taskOrigin;

      // Allow if destination origin matches task origin
      if (destOrigin === taskOrigin) {
        allowed = true;
      } else if (this.config.egressAllowlist.includes(destOrigin)) {
        allowed = true;
      } else {
        allowed = false;
      }
    } catch {
      // Malformed URL
      allowed = false;
    }

    this.emit({
      kind: "egress",
      origin: req.sourceOrigin,
      sessionId: req.sessionId,
      detail: `egress ${allowed ? "allowed" : "blocked"}: ${req.destination}`,
      granted: allowed,
    });

    return allowed;
  }

  taintContent(raw: string): TaintedStr {
    this.operator.registerTaint(raw);
    return taint(raw);
  }

  taintTree(value: unknown): void {
    this.operator.registerTaintTree(value);
  }

  operatorTier(tool: string): OperatorTier {
    return this.operator.tier(tool);
  }

  /**
   * Apply an approved policy patch to the LIVE enforcement config (egress
   * allowlist, prohibited actions, origin scope) so policy_set actually changes
   * checkEgress/classify — not just a UI snapshot. Defense-in-depth: the floor
   * primitives are unioned back in unconditionally, so the live prohibited set
   * can never drop below the floor even if a caller bypassed the gate.
   */
  applyPolicy(patch: { allowedOrigins?: string[]; egressAllowlist?: string[]; prohibitedActions?: string[] }): void {
    if (patch.allowedOrigins) replaceInPlace(this.config.allowedOrigins, patch.allowedOrigins);
    if (patch.egressAllowlist) replaceInPlace(this.config.egressAllowlist, patch.egressAllowlist);
    const nextProhibited = patch.prohibitedActions ?? this.config.prohibitedActions;
    const floored = new Set([...nextProhibited, ...CONSTITUTIONAL_FLOOR.prohibitedPrimitives]);
    replaceInPlace(this.config.prohibitedActions, Array.from(floored));
    this.emit({
      kind: "policy",
      origin: "control-plane",
      sessionId: "operator",
      detail: "policy applied to live enforcement (floor re-asserted)",
      granted: true,
    });
  }

  mintHumanGrant(scope: GrantScope): string {
    return this.operator.mintGrant(scope);
  }

  authorizeOperator(req: OperatorRequest): OperatorDecision {
    const decision = this.operator.authorize(req);
    this.emit({
      kind: "operator",
      origin: req.origin,
      sessionId: req.sessionId,
      detail:
        `operator ${req.tool} (${decision.tier}) ` +
        `${decision.allowed ? "allowed" : "blocked"}: ${decision.reason}`,
      granted: decision.allowed,
    });
    return decision;
  }

  auditLog(): ReadonlyArray<AuditEvent> {
    return this.log;
  }

  clearAuditLog(): void {
    this.log.length = 0;
  }

  private emit(event: Omit<AuditEvent, "ts">): void {
    this.log.push({ ts: Date.now(), ...event });
  }
}

/** Replace an array's contents in place (config arrays are shared references). */
function replaceInPlace(target: string[], next: string[]): void {
  target.length = 0;
  target.push(...next);
}
