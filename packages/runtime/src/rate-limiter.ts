/**
 * Per-origin rate limiting + backoff (P1.2).
 *
 * Fan-out spawns N concurrent contexts; pointed at one site they would hammer it
 * like a DDoS — incompatible with the governance positioning. This limiter
 * spaces requests per ORIGIN to a configured rate, backs off exponentially when
 * a site signals overload (429/503), and can honor a robots.txt crawl-delay as
 * a floor. It is SHARED across sessions, so the limit holds across a fan-out.
 *
 * Deterministic by construction: the clock and sleep are injected, so the policy
 * is unit-testable without real time. Single-threaded JS makes the slot
 * reservation atomic — each acquire advances `nextAvailableAt` synchronously
 * before awaiting, so concurrent acquires for the same origin serialize cleanly.
 */

export interface RateLimitConfig {
  /** Default requests/second per origin. */
  readonly requestsPerSecond: number;
  /** Per-origin requests/second overrides (policy override). */
  readonly perOrigin?: Readonly<Record<string, number>>;
  /** HTTP statuses that trigger backoff. Default [429, 503]. */
  readonly backoffStatuses?: ReadonlyArray<number>;
  /** First backoff step, doubled on each repeat. Default 1000ms. */
  readonly initialBackoffMs?: number;
  /** Backoff ceiling. Default 60000ms. */
  readonly maxBackoffMs?: number;
}

interface OriginState {
  /** Earliest time the next request for this origin may start. */
  nextAvailableAt: number;
  /** Current additive backoff penalty (ms), 0 when the site is healthy. */
  backoffMs: number;
  /** robots.txt crawl-delay floor on the interval (ms), 0 if unknown. */
  crawlDelayMs: number;
}

const DEFAULT_BACKOFF_STATUSES = [429, 503];

export class OriginRateLimiter {
  private readonly state = new Map<string, OriginState>();
  private readonly backoffStatuses: ReadonlySet<number>;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.backoffStatuses = new Set(config.backoffStatuses ?? DEFAULT_BACKOFF_STATUSES);
    this.initialBackoffMs = config.initialBackoffMs ?? 1000;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
  }

  private originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  private stateFor(origin: string): OriginState {
    let s = this.state.get(origin);
    if (!s) {
      s = { nextAvailableAt: 0, backoffMs: 0, crawlDelayMs: 0 };
      this.state.set(origin, s);
    }
    return s;
  }

  private minIntervalMs(origin: string): number {
    const rps = this.config.perOrigin?.[origin] ?? this.config.requestsPerSecond;
    return rps > 0 ? 1000 / rps : 0;
  }

  /** Set a robots.txt crawl-delay (seconds) as a floor on this origin's interval. */
  setCrawlDelay(originOrUrl: string, seconds: number): void {
    this.stateFor(this.originOf(originOrUrl)).crawlDelayMs = Math.max(0, seconds * 1000);
  }

  /**
   * Reserve the next slot for `url`'s origin and wait until it is due. Respects
   * the configured rate, any robots.txt crawl-delay, and the current backoff.
   */
  async acquire(url: string): Promise<void> {
    const origin = this.originOf(url);
    const s = this.stateFor(origin);
    const now = this.now();
    const interval = Math.max(this.minIntervalMs(origin), s.crawlDelayMs);
    // This request may start no sooner than the reserved slot, plus any backoff.
    const earliest = Math.max(now, s.nextAvailableAt) + s.backoffMs;
    // Reserve the following slot atomically before we await.
    s.nextAvailableAt = earliest + interval;
    const wait = earliest - now;
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * Report the result of a request. A backoff status grows this origin's penalty
   * exponentially; any other status clears it (the site recovered).
   */
  report(url: string, status: number): void {
    const s = this.stateFor(this.originOf(url));
    if (this.backoffStatuses.has(status)) {
      s.backoffMs = Math.min(this.maxBackoffMs, s.backoffMs > 0 ? s.backoffMs * 2 : this.initialBackoffMs);
    } else {
      s.backoffMs = 0;
    }
  }

  /** Current backoff penalty for an origin (ms) — for observability/tests. */
  backoffFor(originOrUrl: string): number {
    return this.state.get(this.originOf(originOrUrl))?.backoffMs ?? 0;
  }
}
