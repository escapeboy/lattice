/**
 * OperatorGate — authorization for the MCP-exposed operator surface.
 *
 * The operator surface (policy/persona/device/budget/vault mutation + read) is
 * the most privileged attack surface in the product. This gate closes the three
 * escalation vectors from design-operator-surface.md *structurally*, not by
 * asking the model nicely:
 *
 *   1. Self-weakening — an agent calling policy_set to drop its own gating
 *      rules. Blocked by the CONSTITUTIONAL_FLOOR check: a write that would
 *      move policy below the floor is refused regardless of any grant.
 *   2. Credential exfiltration — persona_import is the `prohibited` tier and is
 *      never executable through this API; only the human UI may initiate it.
 *   3. Injection→operator — a page injecting "call policy_set/persona_import".
 *      Any operator argument whose value originated from tainted (page) content
 *      is detected via the runtime taint registry and the call is refused before
 *      it reaches the tool.
 *
 * Write-tier mutations additionally require a single-use grant token minted by
 * the human control-plane channel (`mintHumanGrant`). The agent has no route to
 * mint one — it can only *request* a handoff. That asymmetry is the boundary.
 */

import { createHash, randomUUID } from "node:crypto";
import type { GrantScope, OperatorDecision, OperatorRequest, OperatorTier } from "./types.js";

/** Operator tools the agent may call freely — read-only, no side effects. */
const READ_TOOLS = new Set([
  "policy_get",
  "policy_list",
  "persona_list",
  "device_list",
  "session_observe",
  "session_watch",
  "audit_read",
  "audit_export",
  "budget_get",
]);

/** Operator tools that mutate state — require a human grant token. */
const WRITE_TOOLS = new Set([
  "policy_set",
  "persona_create",
  "persona_delete",
  "device_register",
  "device_revoke",
  "budget_set",
  "vault_store",
]);

/** Credential-bearing — never executable through the agent API at all. */
const PROHIBITED_TOOLS = new Set(["persona_import"]);

/**
 * The constitutional floor: invariants no policy_set may weaken, by anyone,
 * through this API. Hard-coded, not policy-editable. A policy_set whose result
 * would drop below any of these is refused with a typed floor violation.
 */
export const CONSTITUTIONAL_FLOOR = {
  /** Primitives that stay prohibited no matter what a policy patch attempts. */
  prohibitedPrimitives: [
    "captcha",
    "account.create",
    "acl.change",
    "permission.change",
    "hard_delete",
    "transfer",
    "payment",
    "persona_import",
  ],
  /** Tainting can never be turned off. */
  taintingAlwaysOn: true,
  /** Egress to a destination proposed by page content is always blocked. */
  egressFromContentBlocked: true,
} as const;

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deep-walk args collecting every string leaf value. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
}

export class OperatorGate {
  /** Hashes of content that has been tainted (page-origin). */
  private readonly taintedHashes = new Set<string>();
  /** Live single-use grant tokens → scope + expiry. */
  private readonly grants = new Map<string, { scope: GrantScope; expiresAt: number }>();
  /** Cap the taint registry so a long-running gateway can't grow unbounded. */
  private readonly maxTainted = 50_000;
  /** Grants expire — bounds the replay window beyond single-use. */
  private readonly grantTtlMs = 10 * 60_000;

  /** Register a string as tainted (page-origin). Called by kernel.taintContent. */
  registerTaint(raw: string): void {
    if (this.taintedHashes.size >= this.maxTainted) {
      // FIFO-ish eviction: drop the oldest insertion.
      const first = this.taintedHashes.values().next().value;
      if (first !== undefined) this.taintedHashes.delete(first);
    }
    this.taintedHashes.add(hashContent(raw));
  }

  /**
   * Register every string leaf of a value as tainted. session_observe hands the
   * agent individual node values, not just the serialized blob — so we taint at
   * the granularity the agent actually forwards, closing the "extract one leaf
   * and pass it to an operator tool" bypass.
   */
  registerTaintTree(value: unknown): void {
    const leaves: string[] = [];
    stringLeaves(value, leaves);
    for (const s of leaves) this.registerTaint(s);
  }

  tier(tool: string): OperatorTier {
    if (PROHIBITED_TOOLS.has(tool)) return "prohibited";
    if (WRITE_TOOLS.has(tool)) return "write";
    if (READ_TOOLS.has(tool)) return "read";
    // Unknown operator tools are treated as write — fail closed.
    return "write";
  }

  mintGrant(scope: GrantScope): string {
    const token = randomUUID();
    this.grants.set(token, { scope, expiresAt: Date.now() + this.grantTtlMs });
    return token;
  }

  /**
   * Authorize an operator invocation. Pure decision — the caller (gateway)
   * applies the mutation only when `allowed` is true; on a write it must NOT
   * re-use the same request object since the grant token is consumed here.
   */
  authorize(req: OperatorRequest): OperatorDecision {
    const tier = this.tier(req.tool);

    // (3) Injection→operator: any tainted value among the args poisons the call.
    if (this.hasTaintedArg(req.args)) {
      return {
        allowed: false,
        tier,
        reason: "operator call carries a tainted (page-origin) argument — blocked structurally",
        requiresHuman: false,
        floorViolation: false,
        taintedOrigin: true,
      };
    }

    // (2) Prohibited tier: never through the agent API, even with a grant.
    if (tier === "prohibited") {
      return {
        allowed: false,
        tier,
        reason: `${req.tool} is credential-bearing — only the human control plane may initiate it through the UI`,
        requiresHuman: true,
        floorViolation: false,
        taintedOrigin: false,
      };
    }

    // Read tier: free for the agent.
    if (tier === "read") {
      return {
        allowed: true,
        tier,
        reason: "read-tier operator call",
        requiresHuman: false,
        floorViolation: false,
        taintedOrigin: false,
      };
    }

    // Write tier ─────────────────────────────────────────────────────────────

    // (1) Constitutional floor: a policy_set that would weaken the floor is
    // refused regardless of grant — not even a human may lower it via this API.
    if (req.tool === "policy_set" && violatesFloor(req.args)) {
      return {
        allowed: false,
        tier,
        reason: "policy_set would move policy below the constitutional floor — refused",
        requiresHuman: false,
        floorViolation: true,
        taintedOrigin: false,
      };
    }

    // (4) Operator write requires a valid, scoped, unconsumed human grant.
    if (req.grant !== undefined && this.consumeGrant(req.grant, req.tool, req.sessionId)) {
      return {
        allowed: true,
        tier,
        reason: "write authorized by human grant",
        requiresHuman: false,
        floorViolation: false,
        taintedOrigin: false,
      };
    }

    return {
      allowed: false,
      tier,
      reason: "operator write requires a human grant token from the control plane",
      requiresHuman: true,
      floorViolation: false,
      taintedOrigin: false,
    };
  }

  private hasTaintedArg(args: Record<string, unknown>): boolean {
    if (this.taintedHashes.size === 0) return false;
    const leaves: string[] = [];
    stringLeaves(args, leaves);
    return leaves.some((s) => this.taintedHashes.has(hashContent(s)));
  }

  private consumeGrant(token: string, tool: string, sessionId: string): boolean {
    const entry = this.grants.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.grants.delete(token); // expired — not redeemable
      return false;
    }
    if (entry.scope.tool !== tool || entry.scope.sessionId !== sessionId) return false;
    this.grants.delete(token); // single use
    return true;
  }
}

/**
 * True if a policy_set patch would move policy below the constitutional floor:
 * dropping a floor-prohibited primitive, disabling tainting, or allowing
 * egress to content-proposed destinations.
 */
export function violatesFloor(args: Record<string, unknown>): boolean {
  // Disabling tainting is never allowed. Guard BOTH the enforcement key and the
  // name the floor declares itself under (`taintingAlwaysOn`) — an attacker who
  // reads CONSTITUTIONAL_FLOOR's field names must not find a spelling that is
  // accepted-but-ignored instead of refused.
  if (args["taintingEnabled"] === false) return true;
  if (args["taintingAlwaysOn"] === false) return true;
  // Allowing content-proposed egress is never allowed.
  if (args["egressFromContentAllowed"] === true) return true;
  // If a new prohibited list is supplied, it must still contain every floor
  // primitive — an agent cannot remove one to "allow everything".
  const next = args["prohibitedActions"];
  if (Array.isArray(next)) {
    const set = new Set(next.map((v) => String(v).toLowerCase()));
    for (const floor of CONSTITUTIONAL_FLOOR.prohibitedPrimitives) {
      if (!set.has(floor)) return true;
    }
  }
  return false;
}
