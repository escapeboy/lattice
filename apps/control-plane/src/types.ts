/**
 * Control Plane types — shared across inbox, policy, server, and UI.
 */

/** One field in an approval's data preview. `masked` values never carry a secret. */
export interface ApprovalField {
  readonly label: string;
  readonly value: string;
  readonly masked: boolean;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly origin: string;
  readonly actionType: string;
  readonly policyClass: string;
  readonly summary: string;
  readonly createdAt: number;
  /** Human-readable action, e.g. "Submit form (2 fields)". */
  readonly action?: string;
  /** Target control label, when known. */
  readonly targetLabel?: string;
  /** Why it needs approval, e.g. "consequential — matches requireGrant rule 'submit'". */
  readonly why?: string;
  /** Data being submitted (secrets masked; never bypasses tainting). */
  readonly fields?: ReadonlyArray<ApprovalField>;
  /** Agent-declared intent — UNTRUSTED, display-only. */
  readonly intent?: string;
  /** Epoch ms when an unanswered request auto-resolves (timeout fallback), if set. */
  readonly expiresAt?: number;
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

/**
 * A session that has just ended — kept briefly so the Theater can show a
 * "recently ended" catch-up section for an operator who opens it a moment after
 * an ephemeral create→act→destroy run finished (the live list drops it on
 * teardown). SHORT-LIVED, in-memory ONLY (TTL-pruned, capped) — it carries the
 * same non-secret session view, never PII, and is NOT the durable trace store
 * (those stay redacted in Svod).
 */
export interface RecentlyEndedSession extends SessionView {
  /** Epoch ms when the session was removed from the live theater. */
  readonly endedAt: number;
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
