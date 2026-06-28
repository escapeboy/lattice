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

// Default prohibited action prefixes — never allowed regardless of config.
// DERIVED from the constitutional floor so there is ONE source of truth: adding
// a primitive to CONSTITUTIONAL_FLOOR.prohibitedPrimitives prohibits it in
// classify() too, instead of silently relying on a hand-copied (drift-prone)
// duplicate. (Audit GAP #1: the copy had drifted, omitting persona_import.)
const ALWAYS_PROHIBITED: ReadonlySet<string> = new Set(
  CONSTITUTIONAL_FLOOR.prohibitedPrimitives.map((p) => p.toLowerCase()),
);

// Action types that are consequential by default
export const CONSEQUENTIAL_DEFAULTS = new Set([
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

  setGrantHandler(handler: (req: CapabilityRequest) => Promise<GrantDecision>): void {
    this.config.grantHandler = handler;
  }

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

    // Consequential — built-in defaults plus any operator-tightened types. The
    // operator `requireGrant` list flows here via applyPolicy, so editing it
    // actually gates classification (not just a UI snapshot).
    for (const c of CONSEQUENTIAL_DEFAULTS) {
      if (lower === c || lower.startsWith(c)) return "consequential";
    }
    for (const c of this.config.consequentialActions ?? []) {
      const cl = c.toLowerCase();
      if (lower === cl || lower.startsWith(cl)) return "consequential";
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
    // Constitutional floor: local-file / sandbox-escaping schemes are refused
    // unconditionally — BEFORE the empty-allowlist short-circuit — so an
    // `open file:///etc/passwd` is blocked even under the unrestricted dev
    // default. This is not policy-editable.
    if (hasForbiddenScheme(targetUrl)) {
      this.emit({
        kind: "policy",
        origin: "task",
        sessionId: "navigation",
        detail: `navigation blocked (forbidden scheme): ${targetUrl.slice(0, 80)}`,
        granted: false,
      });
      return false;
    }
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
    // Provenance (A4): a destination is content-proposed when its source is not
    // the task scope. A same-origin destination is allowed regardless (legitimate
    // forms post to their own origin); a CROSS-origin destination is allowed only
    // if explicitly allowlisted — so a content-proposed off-origin exfil target is
    // blocked. The sourceOrigin is consulted (not a dead field) and audited.
    const contentProposed = req.sourceOrigin !== req.taskOrigin;
    try {
      const dest = new URL(req.destination);
      const destOrigin = dest.origin;
      const taskOrigin = req.taskOrigin;

      if (destOrigin === taskOrigin) {
        allowed = true; // same-origin — legitimate forms/fetch
      } else if (this.config.egressAllowlist.includes(destOrigin)) {
        allowed = true; // explicitly allowlisted cross-origin
      } else {
        allowed = false; // cross-origin, not allowlisted (incl. all content-proposed exfil)
      }
    } catch {
      // Malformed URL
      allowed = false;
    }

    this.emit({
      kind: "egress",
      origin: req.sourceOrigin,
      sessionId: req.sessionId,
      detail: `egress ${allowed ? "allowed" : "blocked"} (${contentProposed ? "content-proposed" : "task-proposed"}): ${req.destination}`,
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
  applyPolicy(patch: { allowedOrigins?: string[]; egressAllowlist?: string[]; prohibitedActions?: string[]; consequentialActions?: string[] }): void {
    if (patch.allowedOrigins) replaceInPlace(this.config.allowedOrigins, patch.allowedOrigins);
    if (patch.egressAllowlist) replaceInPlace(this.config.egressAllowlist, patch.egressAllowlist);
    if (patch.consequentialActions) {
      this.config.consequentialActions ??= [];
      replaceInPlace(this.config.consequentialActions, patch.consequentialActions);
    }
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

  recordHumanImport(personaId: string, origins: string[], cookieCount: number): void {
    this.emit({
      kind: "operator",
      origin: "control-plane",
      sessionId: "persona-import",
      detail: `persona_import (human): ${cookieCount} cookies for [${origins.join(", ")}] → persona ${personaId} (values not exposed)`,
      granted: true,
    });
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

const FORBIDDEN_NAV_SCHEMES = new Set([
  "file",
  "javascript",
  "blob",
  "filesystem",
  "view-source",
  "chrome",
  "chrome-extension",
  "chrome-untrusted",
  "devtools",
]);

/**
 * True if `url`'s scheme reads local files or escapes the page sandbox.
 *
 * Canonicalizes to a STRICT SUPERSET of any URL resolver before reading the
 * scheme: removes EVERY code point <= 0x20 (all C0 controls + space) anywhere.
 * The WHATWG parser strips tab/newline + leading control/space; Chromium's
 * lenient fixup may also strip control/space from inside the scheme. So
 * `fi\tle://`, `fi<FF>le://`, `fi<space>le://`, leading NUL — anything a
 * downstream resolver could canonicalize to `file:` — is caught, without
 * false-blocking http/https/data/about. Char codes only (no control chars here).
 */
function hasForbiddenScheme(url: string): boolean {
  // Canonicalize before reading the scheme (mirrors engine-adapter's
  // forbiddenUrlScheme): percent-decode, NFKC-normalize, then strip <=0x20 — so
  // `fi%6ce:`, `file%3a`, fullwidth confusables, and tab/control obfuscation all
  // collapse to the real scheme.
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* malformed %-sequence — fall back to the raw string */
  }
  decoded = decoded.normalize("NFKC");
  let s = "";
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) > 0x20) s += decoded[i];
  }
  const colon = s.indexOf(":");
  if (colon < 0) return false;
  return FORBIDDEN_NAV_SCHEMES.has(s.slice(0, colon).toLowerCase());
}
