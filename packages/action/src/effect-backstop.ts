/**
 * Effect backstop — gate on what the action actually SENT, not on what we
 * predicted it would send.
 *
 * The classifier in `@lattice/kernel` reads the DOM. A page can lie to the DOM:
 * `<button type="button">Continue</button>` with a JS handler that calls
 * `fetch('/api/orders', {method:'POST'})` reads as benign and is auto-granted.
 * Nothing in a static analysis catches that, because the evidence only exists
 * once the click has run.
 *
 * So: while an auto-granted action is in flight, every request the page makes
 * is paused at `Fetch.requestPaused` BEFORE it leaves the browser. A request
 * that changes state (POST/PUT/PATCH/DELETE, or a credentialed cross-origin
 * GET) is escalated to the same human grant the action would have needed. On
 * refusal it is failed, not sent — the gate holds even though the click already
 * happened, because the click is not the effect; the request is.
 *
 * SCOPE AND HONEST LIMITS
 * - It covers network effects only. A click that writes localStorage, mutates
 *   the DOM, or triggers a service-worker-cached write is invisible here.
 * - `Fetch.enable` pauses EVERY request, so the browser's whole network path
 *   now round-trips through this process. Cost is measured in the tests.
 * - Attribution is temporal: a request is blamed on the action that was in
 *   flight when it started. A page that delays its POST past the window is not
 *   attributed. Widening the window trades false positives for coverage.
 * - It is OFF unless explicitly enabled.
 */

import type { CDPHandle } from "@lattice/engine";

export interface PausedRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  /** Why this was held. */
  readonly reason: string;
}

export type EscalationHandler = (req: PausedRequest) => Promise<boolean>;

export interface BackstopOptions {
  /** Origin the session is scoped to; cross-origin is judged against this. */
  readonly taskOrigin?: string;
  /**
   * How long after a dispatch a request is still attributed to it.
   * Shorter = fewer false positives, more misses. 1500ms covers a click →
   * handler → fetch chain with a rendering frame in between.
   */
  readonly windowMs?: number;
  /** Called for each held request; resolve true to let it through. */
  readonly onEscalate: EscalationHandler;
  /** Observability hook — every decision, held or not. */
  readonly onDecision?: (req: PausedRequest, allowed: boolean) => void;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resource types that never commit anything on their own. Analytics beacons and
 * CSP reports are the dominant false-positive source in practice, and the
 * browser already labels them.
 */
const NON_COMMITTING_TYPES = new Set(["Ping", "CSPViolationReport", "Prefetch", "Preflight"]);

interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  resourceType: string;
  responseStatusCode?: number;
}

export class EffectBackstop {
  private armedUntil = 0;
  private enabled = false;
  private held = 0;
  private blocked = 0;
  private seen = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly cdp: CDPHandle,
    private readonly opts: BackstopOptions,
  ) {}

  /** Counters for the feasibility report. */
  stats(): { seen: number; held: number; blocked: number } {
    return { seen: this.seen, held: this.held, blocked: this.blocked };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    this.unsubscribe = this.cdp.on("Fetch.requestPaused", (data) => {
      void this.onPaused(data as FetchRequestPausedEvent);
    });
    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    this.enabled = true;
  }

  async disable(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.cdp.send("Fetch.disable", {}).catch(() => undefined);
  }

  /**
   * Open the attribution window. Called immediately before dispatching an
   * action that the classifier auto-granted — a consequential action already
   * has its human grant and does not need a second one.
   */
  arm(): void {
    this.armedUntil = Date.now() + (this.opts.windowMs ?? 1500);
  }

  /** Close the window early (the action threw, or settling finished). */
  disarm(): void {
    this.armedUntil = 0;
  }

  private async onPaused(e: FetchRequestPausedEvent): Promise<void> {
    this.seen += 1;
    // Response stage — not intercepted here, but be defensive.
    if (e.responseStatusCode !== undefined) {
      await this.cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
      return;
    }

    const reason = this.holdReason(e);
    if (!reason) {
      await this.cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
      return;
    }

    const req: PausedRequest = {
      requestId: e.requestId,
      url: e.request.url,
      method: e.request.method.toUpperCase(),
      resourceType: e.resourceType,
      reason,
    };
    this.held += 1;

    let allowed = false;
    try {
      allowed = await this.opts.onEscalate(req);
    } catch {
      allowed = false; // an escalation that errors is a refusal, never a pass
    }
    this.opts.onDecision?.(req, allowed);

    if (allowed) {
      await this.cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
    } else {
      this.blocked += 1;
      await this.cdp
        .send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" })
        .catch(() => undefined);
    }
  }

  /** Why this request should be held, or undefined to let it through. */
  private holdReason(e: FetchRequestPausedEvent): string | undefined {
    if (Date.now() > this.armedUntil) return undefined;
    if (NON_COMMITTING_TYPES.has(e.resourceType)) return undefined;

    const method = e.request.method.toUpperCase();
    if (STATE_CHANGING.has(method)) {
      return `${method} issued by an action auto-granted as benign`;
    }

    // A credentialed cross-origin GET is a read for the SITE but an
    // authenticated action for the agent — it carries the session outward.
    if (method === "GET" && this.opts.taskOrigin) {
      const cookie = e.request.headers?.["Cookie"] ?? e.request.headers?.["cookie"];
      if (cookie && !this.isSameOrigin(e.request.url)) {
        return "credentialed cross-origin GET issued by an auto-granted action";
      }
    }
    return undefined;
  }

  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.opts.taskOrigin!).origin;
    } catch {
      return false;
    }
  }
}
