/**
 * OperatorStore — state behind the operator surface (policy snapshot, personas,
 * devices, budget). This holds *data only*; every mutation is gated by the
 * SecurityKernel's OperatorGate before it reaches here. The store never
 * authorizes — it applies a change the kernel has already approved.
 *
 * Secrets never live here: persona records carry origin scope, not cookies;
 * device records carry a push channel (ntfy topic), not a credential. Real
 * credentials live in the Vault.
 */

import { randomUUID } from "node:crypto";

export interface PersonaRecord {
  readonly id: string;
  readonly label: string;
  readonly origins: string[];
  readonly createdAt: number;
}

export type DeviceChannel = "ntfy" | "webpush";

export interface DeviceRecord {
  readonly id: string;
  readonly label: string;
  readonly channel: DeviceChannel;
  /** ntfy topic or Web Push endpoint — the notification address, not a secret. */
  readonly target: string;
  readonly registeredAt: number;
}

export interface BudgetState {
  readonly limitTokens: number;
  readonly spentTokens: number;
}

export interface PolicySnapshot {
  allowedOrigins: string[];
  egressAllowlist: string[];
  prohibitedActions: string[];
  requireGrant: string[];
  /** Constitutional invariants — surfaced read-only; the kernel floor enforces them. */
  readonly taintingEnabled: true;
  readonly egressFromContentAllowed: false;
}

const DEFAULT_POLICY: PolicySnapshot = {
  allowedOrigins: [],
  egressAllowlist: [],
  prohibitedActions: ["captcha", "account.create", "acl.change", "permission.change", "hard_delete", "transfer", "payment", "persona_import"],
  requireGrant: ["submit", "form.submit", "delete", "checkout", "purchase", "send_email", "send_message"],
  taintingEnabled: true,
  egressFromContentAllowed: false,
};

export class OperatorStore {
  private policy: PolicySnapshot;
  private readonly personas = new Map<string, PersonaRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private budget: BudgetState;

  constructor(initial?: { policy?: Partial<PolicySnapshot>; budgetLimit?: number }) {
    this.policy = { ...DEFAULT_POLICY, ...initial?.policy, taintingEnabled: true, egressFromContentAllowed: false };
    this.budget = { limitTokens: initial?.budgetLimit ?? 0, spentTokens: 0 };
  }

  // ── policy ──────────────────────────────────────────────────────────────────
  getPolicy(): PolicySnapshot {
    return { ...this.policy };
  }

  /** Apply a policy patch. Caller MUST have passed the kernel floor+grant gate. */
  setPolicy(patch: Partial<PolicySnapshot>): PolicySnapshot {
    this.policy = {
      allowedOrigins: patch.allowedOrigins ?? this.policy.allowedOrigins,
      egressAllowlist: patch.egressAllowlist ?? this.policy.egressAllowlist,
      prohibitedActions: patch.prohibitedActions ?? this.policy.prohibitedActions,
      requireGrant: patch.requireGrant ?? this.policy.requireGrant,
      taintingEnabled: true,
      egressFromContentAllowed: false,
    };
    return this.getPolicy();
  }

  // ── personas ────────────────────────────────────────────────────────────────
  listPersonas(): PersonaRecord[] {
    return Array.from(this.personas.values());
  }

  createPersona(label: string, origins: string[]): PersonaRecord {
    const rec: PersonaRecord = { id: randomUUID(), label, origins, createdAt: Date.now() };
    this.personas.set(rec.id, rec);
    return rec;
  }

  deletePersona(id: string): boolean {
    return this.personas.delete(id);
  }

  // ── devices ─────────────────────────────────────────────────────────────────
  listDevices(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }

  registerDevice(label: string, channel: DeviceChannel, target: string): DeviceRecord {
    const rec: DeviceRecord = { id: randomUUID(), label, channel, target, registeredAt: Date.now() };
    this.devices.set(rec.id, rec);
    return rec;
  }

  revokeDevice(id: string): boolean {
    return this.devices.delete(id);
  }

  // ── budget ──────────────────────────────────────────────────────────────────
  getBudget(): BudgetState {
    return { ...this.budget };
  }

  setBudget(limitTokens: number): BudgetState {
    this.budget = { ...this.budget, limitTokens };
    return this.getBudget();
  }
}
