/**
 * HandoffManager — human-in-the-loop intervention (S8.5).
 *
 * When an agent hits a wall it cannot (and must not) cross alone — login, 2FA,
 * captcha, a consequential confirmation — it raises a `session_handoff`. The
 * request fans out to every registered operator device in parallel; the first
 * device to claim wins (single-flight) and the rest are told it resolved
 * elsewhere. Model: **notify everywhere, claim once**.
 *
 * Two request types with different ceilings (design-persona-and-handoff.md):
 *   - approval (Type A): low-bandwidth confirm/deny — ntfy push with buttons.
 *   - input   (Type B): a single field (2FA code, password). The value flows
 *     Vault → form in the context, NEVER through the model/agent/trace. This
 *     manager records only THAT a field was filled, never its value.
 *
 * Security: every input request is signed (HMAC) by the control plane so the
 * PWA can verify origin before showing a form — a push saying "type your
 * password here" is otherwise a perfect phishing vector. Every handoff event
 * (raise, fan-out, claim, resolve, fill, expire) is appended to an immutable
 * audit log.
 *
 * Production notes: the claim lock is in-process here (single JS thread makes
 * the check-and-set atomic); a multi-process deployment swaps it for a Redis
 * lock. The notification transport is injectable — NtfyTransport in production,
 * a collector in tests.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { DeviceRecord } from "./operator.js";

export type HandoffType = "approval" | "input";
export type HandoffStatus = "pending" | "claimed" | "approved" | "denied" | "filled" | "expired";

export interface HandoffRequest {
  readonly id: string;
  readonly type: HandoffType;
  readonly sessionId: string;
  readonly origin: string;
  readonly reason: string;
  /** For input handoffs: which field the human is asked to provide (human label). */
  readonly field?: string;
  /** For input handoffs: the perception nodeId the value is filled into. Stored
   *  at raise time (the agent knows it) so the operator only supplies the VALUE
   *  — they never need to know node ids or session ids. */
  readonly fieldNodeId?: string;
  readonly createdAt: number;
  readonly ttlMs: number;
  /** HMAC over the request — the PWA verifies this before rendering a form. */
  readonly signature: string;
  status: HandoffStatus;
  claimedBy?: string;
}

export interface HandoffNotification {
  readonly handoffId: string;
  readonly type: HandoffType;
  readonly origin: string;
  readonly reason: string;
  readonly field?: string;
  readonly signature: string;
}

export interface NotificationTransport {
  notify(device: DeviceRecord, payload: HandoffNotification): Promise<void>;
}

export interface HandoffAuditEvent {
  readonly ts: number;
  readonly handoffId: string;
  readonly kind: "raise" | "fanout" | "claim" | "resolve" | "fill" | "expire";
  readonly detail: string;
}

/** TTL-expiry behaviour, configurable per policy. Default: pause + audit. */
export type ExpiryPolicy = "pause_and_audit" | "escalate";

/** A transport that drops notifications — safe default when no channel is wired. */
export class NullTransport implements NotificationTransport {
  notify(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Posts an approval/input notification to an ntfy topic (Type A channel). Only
 * used when a base URL is configured; egress is the operator's own ntfy server.
 */
export class NtfyTransport implements NotificationTransport {
  constructor(private readonly baseUrl: string) {}

  async notify(device: DeviceRecord, payload: HandoffNotification): Promise<void> {
    if (device.channel !== "ntfy") return;
    const url = `${this.baseUrl.replace(/\/$/, "")}/${device.target}`;
    await fetch(url, {
      method: "POST",
      headers: { Title: `Lattice handoff: ${payload.type}`, Priority: "high" },
      body: `${payload.reason} (${payload.origin})`,
    });
  }
}

export class HandoffManager {
  private readonly requests = new Map<string, HandoffRequest>();
  private readonly log: HandoffAuditEvent[] = [];

  constructor(
    private readonly transport: NotificationTransport,
    private readonly signingKey: string,
    private readonly defaultTtlMs = 5 * 60_000,
    private readonly expiryPolicy: ExpiryPolicy = "pause_and_audit",
  ) {}

  private sign(parts: { id: string; type: HandoffType; sessionId: string; origin: string; reason: string; field: string; createdAt: number }): string {
    // reason+origin are INSIDE the signature: the human approves based on them,
    // so they must be authenticated, not just the request identity.
    return createHmac("sha256", this.signingKey)
      .update(`${parts.id}|${parts.type}|${parts.sessionId}|${parts.origin}|${parts.reason}|${parts.field}|${parts.createdAt}`)
      .digest("hex");
  }

  /** True if a request's signature is authentic — the PWA calls this. */
  verifySignature(req: HandoffRequest): boolean {
    const expected = this.sign({
      id: req.id,
      type: req.type,
      sessionId: req.sessionId,
      origin: req.origin,
      reason: req.reason,
      field: req.field ?? "",
      createdAt: req.createdAt,
    });
    return expected === req.signature;
  }

  /**
   * Raise a handoff and fan it out to all devices in parallel (notify
   * everywhere). Returns the request; the agent polls status, it does not block.
   */
  async raise(
    opts: { type: HandoffType; sessionId: string; origin: string; reason: string; field?: string; fieldNodeId?: string; ttlMs?: number },
    devices: readonly DeviceRecord[],
  ): Promise<HandoffRequest> {
    const id = randomUUID();
    const createdAt = Date.now();
    const signature = this.sign({
      id,
      type: opts.type,
      sessionId: opts.sessionId,
      origin: opts.origin,
      reason: opts.reason,
      field: opts.field ?? "",
      createdAt,
    });
    const req: HandoffRequest = {
      id,
      type: opts.type,
      sessionId: opts.sessionId,
      origin: opts.origin,
      reason: opts.reason,
      ...(opts.field !== undefined ? { field: opts.field } : {}),
      ...(opts.fieldNodeId !== undefined ? { fieldNodeId: opts.fieldNodeId } : {}),
      createdAt,
      ttlMs: opts.ttlMs ?? this.defaultTtlMs,
      signature,
      status: "pending",
    };
    this.requests.set(id, req);
    this.emit(id, "raise", `${opts.type} handoff: ${opts.reason}`);

    const payload: HandoffNotification = {
      handoffId: id,
      type: opts.type,
      origin: opts.origin,
      reason: opts.reason,
      ...(opts.field !== undefined ? { field: opts.field } : {}),
      signature,
    };
    await Promise.allSettled(devices.map((d) => this.transport.notify(d, payload)));
    this.emit(id, "fanout", `notified ${devices.length} device(s)`);
    return req;
  }

  /**
   * First-claim-wins. Returns true if this device claimed it; false if it was
   * already claimed/resolved/expired (the caller tells that device "resolved
   * elsewhere").
   */
  claim(handoffId: string, deviceId: string): boolean {
    const req = this.expireIfStale(handoffId);
    if (!req || req.status !== "pending") return false;
    req.status = "claimed";
    req.claimedBy = deviceId;
    this.emit(handoffId, "claim", `claimed by ${deviceId}`);
    return true;
  }

  /** Resolve a Type A (approval) handoff — only the claiming device may. */
  resolveApproval(handoffId: string, deviceId: string, approved: boolean): boolean {
    const req = this.expireIfStale(handoffId);
    if (!req || req.status !== "claimed" || req.claimedBy !== deviceId) return false;
    req.status = approved ? "approved" : "denied";
    this.emit(handoffId, "resolve", `${req.status} by ${deviceId}`);
    return true;
  }

  /**
   * Fulfil a Type B (input) handoff. The value flows through `fill` (Vault→form
   * in the context) and is NEVER stored or logged here — only the fact that the
   * field was filled is audited. The claiming device must match.
   */
  async submitInput(
    handoffId: string,
    deviceId: string,
    value: string,
    fill: (value: string) => Promise<void>,
  ): Promise<boolean> {
    const req = this.expireIfStale(handoffId);
    if (!req || req.type !== "input" || req.status !== "claimed" || req.claimedBy !== deviceId) return false;
    await fill(value); // value goes to the form; we never retain it
    req.status = "filled";
    this.emit(handoffId, "fill", `field "${req.field ?? ""}" filled (value not retained)`);
    return true;
  }

  /** Current status, expiring the request first if its TTL has elapsed. */
  status(handoffId: string): HandoffStatus | undefined {
    return this.expireIfStale(handoffId)?.status;
  }

  get(handoffId: string): HandoffRequest | undefined {
    return this.expireIfStale(handoffId);
  }

  pending(): HandoffRequest[] {
    return Array.from(this.requests.values()).filter((r) => {
      this.expireIfStale(r.id);
      return r.status === "pending" || r.status === "claimed";
    });
  }

  auditLog(): readonly HandoffAuditEvent[] {
    return this.log;
  }

  /** Lazy expiry: a pending/claimed request past its TTL transitions to expired. */
  private expireIfStale(handoffId: string, now = Date.now()): HandoffRequest | undefined {
    const req = this.requests.get(handoffId);
    if (!req) return undefined;
    const open = req.status === "pending" || req.status === "claimed";
    if (open && now - req.createdAt >= req.ttlMs) {
      req.status = "expired";
      this.emit(handoffId, "expire", `expired after ${req.ttlMs}ms — policy: ${this.expiryPolicy}`);
    }
    return req;
  }

  private emit(handoffId: string, kind: HandoffAuditEvent["kind"], detail: string): void {
    this.log.push({ ts: Date.now(), handoffId, kind, detail });
  }
}
