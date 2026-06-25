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
