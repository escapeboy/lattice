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
  /** Fulfil an input handoff — the value flows Vault→form; session + field are
   *  resolved from the stored handoff, so only the value is supplied. */
  submitHandoffInput(handoffId: string, deviceId: string, value: string): Promise<boolean>;
  /** Confirm a pending device with the OOB challenge it received. */
  verifyDevice(deviceId: string, challenge: string): boolean;
  /** Apply a human policy edit to the LIVE kernel (floor re-asserted). */
  applyPolicy(patch: Partial<PolicyConfig>): PolicyConfig;
  /** Set the token budget from the UI. */
  setBudget(limitTokens: number): void;
  /** Human-initiated persona import from a real browser profile (credential-bearing). */
  importPersona(personaId: string, profile: string, origins: string[]): Promise<{ imported: number; origins: string[]; restored?: boolean; note?: string }>;
  /** On-disk Chrome profiles available to import from (dir name + display name). */
  listChromeProfiles(): Array<{ dir: string; name: string }>;
  /** Store a credential directly in the local encrypted vault (operator-entered). */
  storeVaultCredential(label: string, origin: string, username: string, password: string): { id: string };
  /** Connect a credential provider (1Password / Bitwarden / Apple Keychain) as a source. */
  connectProvider(id: string, opts?: { scope?: string; session?: string }): { logins: number };
  /** Disconnect a credential provider. */
  disconnectProvider(id: string): void;
  /** Per-provider availability + connection status. */
  providerStatus(): Array<{ id: string; label: string; needsSession: boolean; available: boolean; ready: boolean; detail?: string; connected: boolean; scope?: string; logins: number }>;
  /** Operator read surface: known personas (id + origins + live sessions). No values. */
  listPersonas(): Array<{ personaId: string; origins: string[]; sessions: number }>;
  /** Operator read surface: vault entries as id/origin/label/source ONLY — never credentials. */
  listVault(): Array<{ id: string; origin: string; label: string; source?: string }>;
  /** Ask-to-allow egress: origins the agent tried to reach that are awaiting a decision. */
  egressPending(): Array<{ origin: string; firstSeen: number; attempts: number }>;
  /** Operator allows a pending egress origin (lets it through from the next attempt). */
  egressAllow(origin: string): void;
  /** Operator denies a pending egress origin (stays blocked, no re-prompt). */
  egressDeny(origin: string): void;
}
