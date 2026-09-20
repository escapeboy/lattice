/**
 * Effect backstop — gate on what the action actually SENT, not on what we
 * predicted it would send.
 *
 * The classifier in `@lattice/kernel` reads the DOM, and a page can lie to the
 * DOM: `<button type="button">Continue</button>` whose handler POSTs reads
 * benign on every signal, and correctly so — the evidence only exists after the
 * click. So while an action the gate auto-granted is in flight, requests are
 * paused at `Fetch.requestPaused` BEFORE they leave the browser, and one that
 * commits something is escalated to the same human grant the action would have
 * needed. On refusal it is failed, not sent: the click is not the effect, the
 * request is.
 *
 * COST. `Fetch.enable` pauses every request while it is on, so it is only on
 * inside an armed window — roughly 1.5 s per auto-granted action. Steady-state
 * traffic is untouched. `Network.enable` runs throughout, but it only observes:
 * it supplies the initiator and the pre-action endpoint baseline that
 * `backstop-policy.ts` needs to tell an autosave from an order.
 *
 * HONEST LIMITS. Network effects only — a click that writes localStorage,
 * mutates the DOM, or hits a service-worker cache is invisible here.
 * Attribution is temporal, so a page that delays its POST past the window
 * escapes; widening the window trades false positives for coverage.
 */

import type { CDPHandle } from "@lattice/engine";
import {
  decide,
  endpointKey,
  type BackstopContext,
  type BackstopRequestFacts,
} from "./backstop-policy.js";

export interface PausedRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  /** Why it was held, from the policy. */
  readonly reason: string;
}

export type EscalationHandler = (req: PausedRequest) => Promise<boolean>;

export interface BackstopOptions {
  /** Origin the session is scoped to; cross-origin is judged against this. */
  readonly taskOrigin?: string;
  /**
   * How long after a dispatch a request is still attributed to it. Shorter =
   * fewer false positives and more misses. 1500 ms covers click → handler →
   * fetch with a rendering frame in between.
   */
  readonly windowMs?: number;
  /** Called for each held request; resolve true to let it through. */
  readonly onEscalate: EscalationHandler;
  /** Observability hook — fires for every decision, held or not. */
  readonly onDecision?: (req: PausedRequest, held: boolean, allowed: boolean) => void;
  /** Overridable telemetry host list (tests). */
  readonly telemetryHosts?: readonly string[];
}

export interface BackstopStats {
  /** Requests the policy examined while armed. */
  readonly seen: number;
  /** Requests held and escalated. */
  readonly held: number;
  /** Held requests that were refused and failed. */
  readonly blocked: number;
  /** Endpoint keys observed before the first action. */
  readonly baseline: number;
  /** Total ms spent inside `onPaused`, i.e. added latency. */
  readonly addedLatencyMs: number;
  /** Per-request added latency, for percentiles. */
  readonly latencies: readonly number[];
}

interface FetchRequestPausedEvent {
  requestId: string;
  networkId?: string;
  frameId?: string;
  request: { url: string; method: string; headers?: Record<string, string>; postData?: string };
  resourceType: string;
  responseStatusCode?: number;
}

interface NetworkRequestWillBeSentEvent {
  requestId: string;
  frameId?: string;
  initiator?: { type?: string };
  request: { url: string; method: string; postData?: string; hasPostData?: boolean };
}

/** What `Network.requestWillBeSent` told us, keyed by network request id. */
interface Observed {
  readonly initiatorType: string | undefined;
  readonly postData: string | undefined;
}

export class EffectBackstop {
  private armedUntil = 0;
  private fetchOn = false;
  private observing = false;
  private actedFrameId: string | undefined;
  private agentHasActed = false;

  /** Endpoints the page was already hitting before the agent did anything. */
  private readonly backgroundEndpoints = new Set<string>();
  private readonly observed = new Map<string, Observed>();
  private readonly unsubscribe: Array<() => void> = [];

  private seen = 0;
  private held = 0;
  private blocked = 0;
  private readonly latencies: number[] = [];

  constructor(
    private readonly cdp: CDPHandle,
    private readonly opts: BackstopOptions,
  ) {}

  stats(): BackstopStats {
    return {
      seen: this.seen,
      held: this.held,
      blocked: this.blocked,
      baseline: this.backgroundEndpoints.size,
      addedLatencyMs: this.latencies.reduce((a, b) => a + b, 0),
      latencies: [...this.latencies],
    };
  }

  /**
   * Start observing. Non-blocking: no request is paused until `arm()`.
   * Called once per session, as early as possible, because the value of the
   * baseline depends on having watched the page settle first.
   */
  async observe(): Promise<void> {
    if (this.observing) return;
    this.observing = true;
    this.unsubscribe.push(
      this.cdp.on("Network.requestWillBeSent", (data) => {
        const e = data as NetworkRequestWillBeSentEvent;
        this.observed.set(e.requestId, {
          initiatorType: e.initiator?.type,
          postData: e.request.postData,
        });
        // Anything the page was already doing before the agent's first action is
        // its own background traffic.
        if (!this.agentHasActed) {
          this.backgroundEndpoints.add(endpointKey(e.request.method, e.request.url));
        }
      }),
    );
    await this.cdp.send("Network.enable", {});
  }

  /**
   * Open the attribution window around an action the gate auto-granted.
   * Awaited by the caller BEFORE dispatch — `Fetch.enable` only affects
   * requests started after it takes effect, so arming after the click would
   * miss the very request we are here for.
   */
  async arm(frameId?: string): Promise<void> {
    this.agentHasActed = true;
    this.actedFrameId = frameId;
    this.armedUntil = Date.now() + (this.opts.windowMs ?? 1500);
    if (this.fetchOn) return;
    this.unsubscribe.push(
      this.cdp.on("Fetch.requestPaused", (data) => {
        void this.onPaused(data as FetchRequestPausedEvent);
      }),
    );
    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    this.fetchOn = true;
  }

  /** Close the window and stop pausing. */
  async disarm(): Promise<void> {
    this.armedUntil = 0;
    if (!this.fetchOn) return;
    this.fetchOn = false;
    await this.cdp.send("Fetch.disable", {}).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.disarm();
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.observing = false;
    await this.cdp.send("Network.disable", {}).catch(() => undefined);
  }

  private async onPaused(e: FetchRequestPausedEvent): Promise<void> {
    const started = performance.now();
    const cont = (): Promise<unknown> =>
      this.cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);

    // Response stage is not intercepted; be defensive about a stray event.
    if (e.responseStatusCode !== undefined) {
      await cont();
      return;
    }
    if (Date.now() > this.armedUntil) {
      await cont();
      this.latencies.push(performance.now() - started);
      return;
    }

    this.seen += 1;
    const observed = e.networkId ? this.observed.get(e.networkId) : undefined;
    const headers = e.request.headers ?? {};
    const facts: BackstopRequestFacts = {
      url: e.request.url,
      method: e.request.method,
      resourceType: e.resourceType,
      headers,
      ...(pickPostData(e, observed) !== undefined ? { postData: pickPostData(e, observed)! } : {}),
      ...(e.frameId !== undefined ? { frameId: e.frameId } : {}),
      ...(observed?.initiatorType !== undefined ? { initiatorType: observed.initiatorType } : {}),
      keepalive: isKeepalive(e.resourceType, headers),
    };
    const ctx: BackstopContext = {
      taskOrigin: this.opts.taskOrigin,
      actedFrameId: this.actedFrameId,
      backgroundEndpoints: this.backgroundEndpoints,
      ...(this.opts.telemetryHosts ? { telemetryHosts: this.opts.telemetryHosts } : {}),
    };

    const verdict = decide(facts, ctx);
    const req: PausedRequest = {
      requestId: e.requestId,
      url: e.request.url,
      method: e.request.method.toUpperCase(),
      resourceType: e.resourceType,
      reason: verdict.why,
    };

    if (!verdict.hold) {
      this.opts.onDecision?.(req, false, true);
      await cont();
      this.latencies.push(performance.now() - started);
      return;
    }

    this.held += 1;
    let allowed = false;
    try {
      allowed = await this.opts.onEscalate(req);
    } catch {
      allowed = false; // an escalation that errors is a refusal, never a pass
    }
    this.opts.onDecision?.(req, true, allowed);

    if (allowed) {
      await cont();
    } else {
      this.blocked += 1;
      await this.cdp
        .send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" })
        .catch(() => undefined);
    }
    this.latencies.push(performance.now() - started);
  }
}

/**
 * `Fetch.requestPaused` often omits `postData` for a body it considers large or
 * binary; `Network.requestWillBeSent` usually carries it. Prefer whichever we
 * actually have, because the GraphQL rule is useless without a body — and an
 * absent body on a GraphQL URL is exactly the "unparseable → escalate" case.
 */
function pickPostData(e: FetchRequestPausedEvent, observed: Observed | undefined): string | undefined {
  return e.request.postData ?? observed?.postData;
}

/**
 * `sendBeacon` and `fetch(…, {keepalive:true})`.
 *
 * Chrome surfaces sendBeacon as resourceType `Ping` (or `CSPViolationReport`
 * for reports); a keepalive fetch keeps resourceType `Fetch` but is
 * indistinguishable from an ordinary fetch at the protocol level, so the
 * content-type heuristic below is the only signal available. Beacons carry
 * `text/plain`, a Blob type, or no content-type at all — an application API
 * posting JSON does not look like this.
 */
function isKeepalive(resourceType: string, headers: Readonly<Record<string, string>>): boolean {
  if (resourceType === "Ping" || resourceType === "CSPViolationReport") return true;
  const ct = (headers["content-type"] ?? headers["Content-Type"] ?? "").toLowerCase();
  return ct.startsWith("text/plain") && resourceType !== "XHR";
}
