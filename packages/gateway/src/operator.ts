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
import { CONSTITUTIONAL_FLOOR } from "@lattice/kernel";

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
  /** OOB-verified: a device only receives handoffs once the challenge is confirmed. */
  verified: boolean;
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
    const nextProhibited = patch.prohibitedActions ?? this.policy.prohibitedActions;
    // Defense-in-depth: the floor primitives are unioned in unconditionally, so
    // the stored snapshot can never drop below the floor even if the gate were
    // bypassed. The gate is the primary guard; this is the belt-and-braces.
    const floored = Array.from(new Set([...nextProhibited, ...CONSTITUTIONAL_FLOOR.prohibitedPrimitives]));
    this.policy = {
      allowedOrigins: patch.allowedOrigins ?? this.policy.allowedOrigins,
      egressAllowlist: patch.egressAllowlist ?? this.policy.egressAllowlist,
      prohibitedActions: floored,
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
  /** OOB challenges per pending device (never returned to the agent). */
  private readonly challenges = new Map<string, string>();

  listDevices(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }

  /** Only verified devices receive handoff notifications. */
  verifiedDevices(): DeviceRecord[] {
    return Array.from(this.devices.values()).filter((d) => d.verified);
  }

  /**
   * Register a device as PENDING and return its OOB challenge. The caller sends
   * the challenge over the device's own channel (ntfy/push) — never back to the
   * agent — and the human confirms it via verifyDevice().
   */
  registerDevice(label: string, channel: DeviceChannel, target: string): { device: DeviceRecord; challenge: string } {
    const rec: DeviceRecord = { id: randomUUID(), label, channel, target, registeredAt: Date.now(), verified: false };
    this.devices.set(rec.id, rec);
    const challenge = randomUUID().slice(0, 6).toUpperCase();
    this.challenges.set(rec.id, challenge);
    return { device: rec, challenge };
  }

  /** Confirm a device with the OOB challenge it received on its channel. */
  verifyDevice(id: string, challenge: string): boolean {
    const expected = this.challenges.get(id);
    const device = this.devices.get(id);
    if (!expected || !device || expected !== challenge.toUpperCase()) return false;
    device.verified = true;
    this.challenges.delete(id);
    return true;
  }

  revokeDevice(id: string): boolean {
    this.challenges.delete(id);
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
