/**
 * RobotsChecker — the concrete `RobotsCheckerPort` the serve wiring injects into
 * the governed navigation gate. Before the engine navigates to an arbitrary URL,
 * the GovernedActuator asks `allowed(url)`; a `false` refuses the navigation
 * (borrowed from Lightpanda's `--obey-robots`, adapted to Lattice's governance).
 *
 * GOVERNANCE POSTURE:
 *   - The robots.txt fetch goes through the SAME injected transport as browser
 *     traffic (the egress proxy when the firewall is up), so the check itself is
 *     governed — it never opens an ungoverned side-channel to an origin.
 *   - FAIL-OPEN by default: a robots fetch that errors, times out, or returns
 *     5xx does NOT block the operator's explicit navigation. This DEVIATES from
 *     RFC 9309 §2.3.1.4 (which treats persistent 5xx as disallow-all) on
 *     purpose: the gate's job is to honor EXPLICIT `Disallow` rules, not to turn
 *     a transient robots hiccup into a navigation failure. Set `failClosed:true`
 *     for strict-crawler semantics.
 *   - Results are cached per origin (default 1h) so a crawl doesn't refetch
 *     robots.txt on every page. The clock is injectable for deterministic tests.
 */

import { parseRobots, isAllowed, type RobotsRules } from "./parser.js";

/** The minimal response surface the checker needs (subset of WHATWG Response). */
export interface RobotsResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/** The transport robots.txt is fetched through — `proxiedFetch` satisfies it. */
export type RobotsFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<RobotsResponse>;

export interface RobotsCheckerOptions {
  /** Transport for the robots.txt request (route through the egress proxy). */
  readonly fetch: RobotsFetch;
  /** Product token matched against robots `User-agent` groups. Default "Lattice". */
  readonly userAgent?: string;
  /** Per-origin cache TTL in ms. Default 1h. */
  readonly cacheTtlMs?: number;
  /** Refuse navigation when robots is unreachable/5xx. Default false (fail-open). */
  readonly failClosed?: boolean;
  /** Injectable clock (ms) for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

/** "No robots restrictions" — a fully permissive rule set. */
const ALLOW_ALL: RobotsRules = { groups: [] };

interface CacheEntry {
  readonly rules: RobotsRules;
  readonly expires: number;
}

export class RobotsChecker {
  private readonly fetch: RobotsFetch;
  private readonly userAgent: string;
  private readonly ttl: number;
  private readonly failClosed: boolean;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight fetches, so concurrent navigations to one origin fetch robots once. */
  private readonly inflight = new Map<string, Promise<RobotsRules>>();

  constructor(opts: RobotsCheckerOptions) {
    this.fetch = opts.fetch;
    this.userAgent = opts.userAgent ?? "Lattice";
    this.ttl = opts.cacheTtlMs ?? 60 * 60 * 1000;
    this.failClosed = opts.failClosed ?? false;
    this.now = opts.now ?? Date.now;
  }

  /** True when the product token may fetch `url` per the origin's robots.txt. */
  async allowed(url: string): Promise<boolean> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return true; // a malformed URL is not ours to block here; the kernel scope-check already ran.
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return true;
    const rules = await this.rulesFor(target.origin);
    return isAllowed(rules, this.userAgent, target.pathname + target.search);
  }

  private async rulesFor(origin: string): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached && cached.expires > this.now()) return cached.rules;

    const existing = this.inflight.get(origin);
    if (existing) return existing;

    const pending = this.load(origin).then((rules) => {
      this.cache.set(origin, { rules, expires: this.now() + this.ttl });
      this.inflight.delete(origin);
      return rules;
    }, (err) => {
      this.inflight.delete(origin);
      throw err;
    });
    this.inflight.set(origin, pending);
    return pending;
  }

  private async load(origin: string): Promise<RobotsRules> {
    let res: RobotsResponse;
    try {
      res = await this.fetch(origin + "/robots.txt", { headers: { "user-agent": this.userAgent } });
    } catch {
      // Network error / egress-blocked / timeout → unreachable.
      return this.failClosed ? DISALLOW_ALL : ALLOW_ALL;
    }
    // 2xx → parse. 4xx (incl. 404/403) → no robots ⇒ allow all (spec). 5xx /
    // 3xx / anything else → unreachable ⇒ posture decides.
    if (res.status >= 200 && res.status < 300) {
      try {
        return parseRobots(await res.text());
      } catch {
        return ALLOW_ALL;
      }
    }
    if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
    return this.failClosed ? DISALLOW_ALL : ALLOW_ALL;
  }
}

/** "Disallow everything" — a single `*` group with `Disallow: /`. */
const DISALLOW_ALL: RobotsRules = {
  groups: [{ agents: ["*"], rules: [{ type: "disallow", pattern: "/", re: /^\//, length: 1 }] }],
};
