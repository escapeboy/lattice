/**
 * ApprovalInbox — queues consequential grant requests and fulfills them.
 *
 * Usage:
 *   const inbox = new ApprovalInbox();
 *   // Pass as grantHandler to SecurityKernel:
 *   kernel = new SecurityKernelImpl({ ..., grantHandler: inbox.grantHandler });
 *   // HTTP handler calls:
 *   await inbox.approve(id);  // resolves the pending grant
 */

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";
import type { CapabilityRequest, GrantDecision } from "@lattice/kernel";

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (decision: GrantDecision) => void;
}

export class ApprovalInbox {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly decided: ApprovalDecision[] = [];
  private readonly listeners: Array<(req: ApprovalRequest) => void> = [];

  readonly grantHandler = async (req: CapabilityRequest): Promise<GrantDecision> => {
    const id = randomUUID();
    const approval: ApprovalRequest = {
      id,
      sessionId: req.sessionId,
      origin: req.origin,
      actionType: req.actionType,
      policyClass: "consequential",
      summary: `${req.actionType} on ${req.origin}`,
      createdAt: Date.now(),
    };

    return new Promise<GrantDecision>((resolve) => {
      this.pending.set(id, { request: approval, resolve });
      for (const l of this.listeners) l(approval);
    });
  };

  onRequest(listener: (req: ApprovalRequest) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
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
    this.pending.delete(id);
    entry.resolve({ granted: true, grantId: grantId ?? randomUUID(), reason: "human approved" });
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
    this.pending.delete(id);
    entry.resolve({ granted: false, reason });
    return Promise.resolve(decision);
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
