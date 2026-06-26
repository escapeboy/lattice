/**
 * OperatorGrantInbox — the human side of the operator write tier.
 *
 * When an agent calls an operator-write tool without a grant, the gateway
 * returns `awaiting_human_grant`. That request lands here as a pending operator
 * grant. A human reviewing the control plane approves it; approval mints a
 * single-use grant token via the SHARED SecurityKernel — the very same kernel
 * the gateway authorizes against. The token is handed back to the agent, which
 * retries the write. The agent never mints; only this human approval does.
 *
 * This is the concrete realisation of "UI and MCP share one policy/grant/audit
 * slice" from design-operator-surface.md: one kernel, one audit log, two faces.
 */

import { randomUUID } from "node:crypto";
import type { GrantScope } from "@lattice/kernel";

/** Minimal kernel slice the inbox needs — just the human-grant mint. */
interface GrantMinter {
  mintHumanGrant(scope: GrantScope): string;
}

export interface OperatorGrantRequest {
  readonly id: string;
  readonly scope: GrantScope;
  readonly summary: string;
  readonly createdAt: number;
}

export type OperatorGrantOutcome =
  | { readonly outcome: "approved"; readonly grant: string }
  | { readonly outcome: "denied"; readonly reason: string };

export class OperatorGrantInbox {
  private readonly pending = new Map<string, OperatorGrantRequest>();

  constructor(private readonly kernel: GrantMinter) {}

  /** Raise a pending operator-grant request (mirrors the gateway handoff). */
  request(scope: GrantScope, summary: string): OperatorGrantRequest {
    const req: OperatorGrantRequest = { id: randomUUID(), scope, summary, createdAt: Date.now() };
    this.pending.set(req.id, req);
    return req;
  }

  /** Human approves → mint a single-use grant via the shared kernel. */
  approve(id: string): OperatorGrantOutcome {
    const req = this.pending.get(id);
    if (!req) throw new Error(`Operator grant ${id} not found or already decided`);
    this.pending.delete(id);
    return { outcome: "approved", grant: this.kernel.mintHumanGrant(req.scope) };
  }

  deny(id: string, reason = "human denied"): OperatorGrantOutcome {
    const req = this.pending.get(id);
    if (!req) throw new Error(`Operator grant ${id} not found or already decided`);
    this.pending.delete(id);
    return { outcome: "denied", reason };
  }

  pendingList(): readonly OperatorGrantRequest[] {
    return Array.from(this.pending.values());
  }
}
