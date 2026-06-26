/**
 * CapabilityRegistry — a per-origin map of what an agent can do on a site,
 * cached and improved over time (architecture §5). The fast path is a site that
 * exposes navigator.modelContext / WebMCP: the agent calls declared tools
 * directly instead of scraping the DOM. Declarations are UNTRUSTED — they're a
 * routing hint, still gated like everything else.
 */

export interface OriginCapability {
  readonly origin: string;
  /** Site exposes navigator.modelContext (WebMCP fast path available). */
  readonly nativeMCP: boolean;
  /** Declared action names the site advertises (untrusted, cached). */
  readonly actions: string[];
  readonly lastSeen: number;
}

export class CapabilityRegistry {
  private readonly map = new Map<string, OriginCapability>();
  /** A cached probe is fresh for this long before a re-probe is warranted. */
  constructor(private readonly ttlMs = 10 * 60_000) {}

  /** Origin of a URL, or "" for schemeless (data:/about:). */
  private originOf(url: string): string {
    try {
      const u = new URL(url);
      return u.protocol === "data:" || u.protocol === "about:" ? "" : u.origin;
    } catch {
      return "";
    }
  }

  /** Cached capability for a URL's origin, if still fresh. */
  get(url: string, now = Date.now()): OriginCapability | undefined {
    const origin = this.originOf(url);
    const c = this.map.get(origin);
    if (!c) return undefined;
    return now - c.lastSeen <= this.ttlMs ? c : undefined;
  }

  /** Record a probe result for a URL's origin. */
  record(url: string, nativeMCP: boolean, actions: string[] = [], now = Date.now()): OriginCapability {
    const origin = this.originOf(url);
    const cap: OriginCapability = { origin, nativeMCP, actions, lastSeen: now };
    this.map.set(origin, cap);
    return cap;
  }

  list(): OriginCapability[] {
    return Array.from(this.map.values());
  }
}
