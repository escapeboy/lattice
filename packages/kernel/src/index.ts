/**
 * @lattice/kernel — Security kernel: taint, policy, capability gating, egress firewall
 * (S0 scaffold; implementation in S5)
 */

/** Opaque wrapper for page-origin content; never promotable to instruction context. */
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

export interface SecurityKernel {
  classify(request: CapabilityRequest): PolicyClass;
  requestGrant(request: CapabilityRequest): Promise<GrantDecision>;
  checkEgress(destination: string, origin: string): boolean;
  auditLog(): ReadonlyArray<AuditEvent>;
}

export function createSecurityKernel(): SecurityKernel {
  throw new Error("Not implemented — see S5");
}
