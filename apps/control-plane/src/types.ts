/**
 * Control Plane types — shared across inbox, policy, server, and UI.
 */

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly origin: string;
  readonly actionType: string;
  readonly policyClass: string;
  readonly summary: string;
  readonly createdAt: number;
}

export type ApprovalOutcome = "approved" | "denied";

export interface ApprovalDecision {
  readonly requestId: string;
  readonly outcome: ApprovalOutcome;
  readonly reason?: string;
  readonly decidedAt: number;
}

export interface SessionView {
  readonly sessionId: string;
  readonly url: string;
  readonly lastSnapshotAt?: number;
  readonly nodeCount?: number;
  readonly actionCount: number;
}

export interface PolicyConfig {
  readonly allowedOrigins: string[];
  readonly egressAllowlist: string[];
  readonly prohibitedActions: string[];
  readonly requireGrant: string[];
}

/** A handoff request as the control plane needs to see it (structural). */
export interface HandoffView {
  readonly id: string;
  readonly type: "approval" | "input";
  readonly origin: string;
  readonly reason: string;
  readonly field?: string;
  readonly status: string;
  readonly signature: string;
  readonly createdAt: number;
}

/** Duck-typed view of the gateway's HandoffManager (no gateway dependency). */
export interface HandoffLike {
  pending(): HandoffView[];
  get(id: string): HandoffView | undefined;
  verifySignature(req: HandoffView): boolean;
  claim(id: string, deviceId: string): boolean;
  resolveApproval(id: string, deviceId: string, approved: boolean): boolean;
}

/**
 * The shared core the control plane drives. Realizes "UI and MCP share one
 * grant/audit slice": `kernel` is the same instance the gateway gates against,
 * so a grant minted here authorizes there.
 */
export interface ControlPlaneBackend {
  kernel: { mintHumanGrant(scope: { tool: string; sessionId: string }): string };
  handoffs: HandoffLike;
  submitHandoffInput(
    handoffId: string,
    deviceId: string,
    sessionId: string,
    fieldNodeId: string,
    value: string,
  ): Promise<boolean>;
  /** Confirm a pending device with the OOB challenge it received. */
  verifyDevice(deviceId: string, challenge: string): boolean;
}
