/**
 * ApprovalInbox — queues consequential grant requests and fulfills them.
 *
 * Usage:
 *   const inbox = new ApprovalInbox();
 *   // Pass as grantHandler to SecurityKernel:
 *   kernel = new SecurityKernelImpl({ ..., grantHandler: inbox.grantHandler });
 *   // HTTP handler calls:
 *   await inbox.approve(id);  // resolves the pending grant
 *
 * On Approve → the pending grant resolves granted; the action dispatches.
 * On Deny    → it resolves NOT granted; the actuator raises a typed refusal so
 *              the agent can re-plan or stop.
 * On Timeout → (when a timeout is configured) the request auto-resolves NOT
 *              granted with reason "operator_timeout" — the action is paused
 *              (never executed) and the kernel audits the denied grant.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalField, ApprovalRequest } from "./types.js";
import type { CapabilityRequest, GrantDecision } from "@lattice/kernel";

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (decision: GrantDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ApprovalInboxOptions {
  /**
   * Per-request fallback timeout (ms). If the operator does not decide within
   * this window the request auto-denies (paused + audited). 0/undefined → wait
   * indefinitely (the request holds until a human decides).
   */
  timeoutMs?: number;
}

export class ApprovalInbox {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly decided: ApprovalDecision[] = [];
  private readonly listeners: Array<(req: ApprovalRequest) => void> = [];
  private readonly changeListeners: Array<() => void> = [];
  private readonly timeoutMs: number;

  constructor(opts: ApprovalInboxOptions = {}) {
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  }

  readonly grantHandler = async (req: CapabilityRequest): Promise<GrantDecision> => {
    const id = randomUUID();
    const detail = req.detail;
    const payloadIntent = typeof (req.payload as { intent?: unknown } | null)?.intent === "string"
      ? (req.payload as { intent: string }).intent
      : undefined;
    const fields: ApprovalField[] | undefined = detail?.fields?.map((f) => ({
      label: f.label,
      value: f.value,
      masked: f.masked,
    }));
    const intent = detail?.intent ?? payloadIntent;
    const expiresAt = this.timeoutMs > 0 ? Date.now() + this.timeoutMs : undefined;

    const approval: ApprovalRequest = {
      id,
      sessionId: req.sessionId,
      // Prefer the live page origin (detail) — the session task scope (req.origin)
      // can be unrestricted/empty, which would leave the operator half-informed.
      origin: detail?.origin && detail.origin.length ? detail.origin : req.origin,
      actionType: req.actionType,
      policyClass: "consequential",
      summary: detail?.action ?? `${req.actionType} on ${req.origin}`,
      createdAt: Date.now(),
      ...(detail?.action ? { action: detail.action } : {}),
      ...(detail?.targetLabel ? { targetLabel: detail.targetLabel } : {}),
      why: `consequential — matches requireGrant rule '${req.actionType}'`,
      ...(fields && fields.length ? { fields } : {}),
      ...(intent ? { intent } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };

    return new Promise<GrantDecision>((resolve) => {
      const entry: PendingEntry = { request: approval, resolve };
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => this.timeout(id), this.timeoutMs);
        if (typeof entry.timer.unref === "function") entry.timer.unref();
      }
      this.pending.set(id, entry);
      for (const l of this.listeners) l(approval);
      this.notifyChange();
    });
  };

  onRequest(listener: (req: ApprovalRequest) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Fires on any change to the pending set (add / approve / deny / timeout). */
  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  private notifyChange(): void {
    for (const l of this.changeListeners) l();
  }

  approve(id: string, grantId?: string): Promise<ApprovalDecision> {
    const entry = this.pending.get(id);
    if (!entry) return Promise.reject(new Error(`Approval ${id} not found or already decided`));

    const decision: ApprovalDecision = {
      requestId: id,
      outcome: "approved",
      decidedAt: Date.now(),
    };
    this.decided.push(decision);
    this.clear(id);
    entry.resolve({ granted: true, grantId: grantId ?? randomUUID(), reason: "human approved" });
    this.notifyChange();
    return Promise.resolve(decision);
  }

  deny(id: string, reason = "human denied"): Promise<ApprovalDecision> {
    const entry = this.pending.get(id);
    if (!entry) return Promise.reject(new Error(`Approval ${id} not found or already decided`));

    const decision: ApprovalDecision = {
      requestId: id,
      outcome: "denied",
      reason,
      decidedAt: Date.now(),
    };
    this.decided.push(decision);
    this.clear(id);
    entry.resolve({ granted: false, reason });
    this.notifyChange();
    return Promise.resolve(decision);
  }

  /** Auto-deny an unanswered request (fallback). The action is paused, not run. */
  private timeout(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.decided.push({ requestId: id, outcome: "denied", reason: "operator_timeout", decidedAt: Date.now() });
    this.clear(id);
    // Deny is the safe fallback: the consequential action never executes, and the
    // kernel audits the denied grant. The agent receives a typed refusal.
    entry.resolve({ granted: false, reason: "operator_timeout" });
    this.notifyChange();
  }

  private clear(id: string): void {
    const entry = this.pending.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  pendingList(): readonly ApprovalRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request);
  }

  decisionHistory(): readonly ApprovalDecision[] {
    return [...this.decided];
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }
}
