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
  readonly kind: "grant" | "egress" | "policy" | "prohibited" | "operator";
  readonly origin: string;
  readonly sessionId: string;
  readonly detail: string;
  readonly granted: boolean;
}

/** Operator-surface privilege tiers (see design-operator-surface.md). */
export type OperatorTier = "read" | "write" | "prohibited";

/**
 * A single operator-surface invocation arriving at the kernel for authorization.
 * `grant` is a token minted by the human control-plane channel — the agent has
 * no API to mint one, which is the structural guarantee that write-tier
 * mutations cannot be self-authorized.
 */
export interface OperatorRequest {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly sessionId: string;
  readonly origin: string;
  /** Human grant token, if the control plane minted one for this operation. */
  readonly grant?: string;
}

export interface OperatorDecision {
  readonly allowed: boolean;
  readonly tier: OperatorTier;
  readonly reason: string;
  /** Agent must raise a human handoff to obtain a grant before retrying. */
  readonly requiresHuman: boolean;
  /** The request tried to move policy below the constitutional floor. */
  readonly floorViolation: boolean;
  /** A tainted (page-origin) value was detected among the args. */
  readonly taintedOrigin: boolean;
}

/** Scope a minted human grant is bound to — single operation, single session. */
export interface GrantScope {
  readonly tool: string;
  readonly sessionId: string;
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

export interface KernelConfig {
  /** Task-level origin scope — navigations outside are blocked. */
  allowedOrigins: string[];
  /** Egress allowlist (exact origin strings). Destinations not in this list are blocked. */
  egressAllowlist: string[];
  /** Action types that are always prohibited regardless of other config. */
  prohibitedActions: string[];
  /** Operator-tightened action types that require a human grant (on top of the
   *  built-in consequential defaults). Populated from the policy `requireGrant`
   *  list so editing it actually changes classification. */
  consequentialActions?: string[];
  /** Callback invoked when a consequential action requires human grant. */
  grantHandler?: (req: CapabilityRequest) => Promise<GrantDecision>;
}

export interface SecurityKernel {
  classify(request: CapabilityRequest): PolicyClass;
  requestGrant(request: CapabilityRequest): Promise<GrantDecision>;
  /**
   * Wire the human grant handler for consequential actions after construction.
   * Needed because the approval inbox lives in the control plane, which is built
   * after the kernel — this closes the mutual dependency.
   */
  setGrantHandler(handler: (req: CapabilityRequest) => Promise<GrantDecision>): void;
  checkEgress(req: EgressRequest): boolean;
  /** Origin scoping: is a navigation target within the task's allowed origins? */
  checkNavigation(targetUrl: string): boolean;
  /** Wrap page content in TaintedStr — it must never escape the quarantined channel. */
  taintContent(raw: string): TaintedStr;
  /** Register every string leaf of a value as tainted (page-origin observation). */
  taintTree(value: unknown): void;
  /** Apply an approved policy patch to live enforcement; floor re-asserted. */
  applyPolicy(patch: { allowedOrigins?: string[]; egressAllowlist?: string[]; prohibitedActions?: string[]; consequentialActions?: string[] }): void;
  /** Classify an operator-surface tool into its privilege tier. */
  operatorTier(tool: string): OperatorTier;
  /**
   * Mint a single-use grant token for an operator write. ONLY the human
   * control-plane channel calls this (after an approval). The agent path has
   * no route to it — that asymmetry is the structural authorization boundary.
   */
  mintHumanGrant(scope: GrantScope): string;
  /** Authorize an operator-surface invocation against tier/floor/grant/taint. */
  authorizeOperator(req: OperatorRequest): OperatorDecision;
  /**
   * Record a human-initiated persona import in the immutable audit log. ONLY
   * the control-plane import seam calls this — it is not reachable from any MCP
   * tool, so an agent cannot forge an import record.
   */
  recordHumanImport(personaId: string, origins: string[], cookieCount: number): void;
  auditLog(): ReadonlyArray<AuditEvent>;
  clearAuditLog(): void;
}
