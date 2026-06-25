/**
 * @lattice/control-plane — Human supervision UI (S0 scaffold; Tauri shell in S8)
 *
 * Surfaces: intent input, live session theater, approval inbox, policy editor, replay browser.
 */

export type ControlPlaneMode = "desktop" | "web";

export interface ControlPlaneConfig {
  mode: ControlPlaneMode;
  gatewayEndpoint: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly origin: string;
  readonly actionType: string;
  readonly summary: string;
  readonly createdAt: number;
}

export interface ControlPlane {
  start(config: ControlPlaneConfig): Promise<void>;
  pendingApprovals(): Promise<ReadonlyArray<ApprovalRequest>>;
  approve(requestId: string): Promise<void>;
  deny(requestId: string, reason: string): Promise<void>;
  stop(): Promise<void>;
}

export function createControlPlane(): ControlPlane {
  throw new Error("Not implemented — see S8");
}
