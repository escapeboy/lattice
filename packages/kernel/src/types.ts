/**
 * Security Kernel public types.
 */

/** Opaque wrapper for page-origin content — structurally prevents
 *  promotion to instruction context at the type level. */
export type TaintedStr = string & { readonly __taint: true };

export function taint(raw: string): TaintedStr {
  return raw as TaintedStr;
}

export type PolicyClass = "read" | "benign" | "consequential" | "prohibited";

export interface CapabilityRequest {
  readonly actionType: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly payload: unknown;
}

export interface GrantDecision {
  readonly granted: boolean;
  readonly reason?: string;
  readonly grantId?: string;
}

export interface AuditEvent {
  readonly ts: number;
  readonly kind: "grant" | "egress" | "policy" | "prohibited";
  readonly origin: string;
  readonly sessionId: string;
  readonly detail: string;
  readonly granted: boolean;
}

export interface EgressRequest {
  /** The destination URL being requested */
  readonly destination: string;
  /** Origin that produced the destination (e.g. page content suggested it) */
  readonly sourceOrigin: string;
  /** Origin the current agent task was scoped to */
  readonly taskOrigin: string;
  readonly sessionId: string;
}

export interface PolicyRule {
  actionType: string | RegExp;
  class: PolicyClass;
}

export interface KernelConfig {
  /** Task-level origin scope — navigations outside are blocked. */
  allowedOrigins: string[];
  /** Egress allowlist (exact origin strings). Destinations not in this list are blocked. */
  egressAllowlist: string[];
  /** Action types that are always prohibited regardless of other config. */
  prohibitedActions: string[];
  /** Callback invoked when a consequential action requires human grant. */
  grantHandler?: (req: CapabilityRequest) => Promise<GrantDecision>;
}

export interface SecurityKernel {
  classify(request: CapabilityRequest): PolicyClass;
  requestGrant(request: CapabilityRequest): Promise<GrantDecision>;
  checkEgress(req: EgressRequest): boolean;
  /** Wrap page content in TaintedStr — it must never escape the quarantined channel. */
  taintContent(raw: string): TaintedStr;
  auditLog(): ReadonlyArray<AuditEvent>;
  clearAuditLog(): void;
}
