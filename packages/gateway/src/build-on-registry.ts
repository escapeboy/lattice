/**
 * BuildOnSessionRegistry (ADR 0002, S6 serve flip): a SessionProvider that mints
 * GatewaySessions backed by the build-on stack instead of CDP. The server.ts
 * tool layer is unchanged — it sees the same GatewaySession shape (context /
 * perception / action / recorder), but `context` is the BuildOnContext shim,
 * `perception`/`action` are the build-on adapters, and the underlying engine is
 * agent-browser reached ONLY through the governed BuildOnSession.
 */

import type { SecurityKernel } from "@lattice/kernel";
import type { SemanticEngine } from "@lattice/engine-adapter";
import { TraceRecorder } from "@lattice/observability";
import type { SessionTrace } from "@lattice/observability";
import type { SnapshotData, RateLimitConfig } from "@lattice/runtime";
import { OriginRateLimiter } from "@lattice/runtime";
import { PerceptionCache } from "@lattice/perception";
import { BuildOnSession } from "./build-on-session.js";
import { BuildOnContext } from "./build-on-context.js";
import { BuildOnPerceptionAdapter, BuildOnActionAdapter } from "./build-on-engine.js";
import type { GatewaySession, PersonaInfo, SessionProvider, SessionTopology } from "./sessions.js";
import { randomUUID } from "node:crypto";

export interface BuildOnRegistryOptions {
  /** Task origin scope for the governed session (default: unrestricted dev). */
  origin?: string;
  /** Resource governor: max concurrent live sessions (S4). Default 50. */
  maxSessions?: number;
  /** Per-origin politeness rate limit (P1.2). Off when omitted. */
  rateLimit?: RateLimitConfig;
  /** Per-origin perception cache (P2.2): amortizes the skeleton cost on revisits. */
  perceptionCache?: boolean;
}

/** Thrown when the session governor's budget is exhausted. */
export class SessionBudgetError extends Error {
  constructor(limit: number) {
    super(`session_budget_exceeded: at the ${limit}-session governor cap`);
    this.name = "SessionBudgetError";
  }
}

export class BuildOnSessionRegistry implements SessionProvider {
  private readonly sessions = new Map<string, GatewaySession>();
  /** Imported persona cookies, keyed by personaId (S8.5 persistence glue). */
  private readonly personaCookies = new Map<string, SnapshotData["cookies"]>();
  /** Shared across sessions so a fan-out against one origin obeys the limit (P1.2). */
  private readonly rateLimiter: OriginRateLimiter | undefined;
  /** Shared so a repeat visit to an origin reuses the cached skeleton (P2.2). */
  private readonly perceptionCache: PerceptionCache | undefined;

  constructor(
    private readonly engine: SemanticEngine,
    private readonly kernel: SecurityKernel,
    private readonly opts: BuildOnRegistryOptions = {},
  ) {
    this.rateLimiter = opts.rateLimit ? new OriginRateLimiter(opts.rateLimit) : undefined;
    this.perceptionCache = opts.perceptionCache ? new PerceptionCache() : undefined;
  }

  /** The shared per-origin limiter, if configured — network paths report 429/503 here. */
  get limiter(): OriginRateLimiter | undefined {
    return this.rateLimiter;
  }

  async create(topology: SessionTopology = "ephemeral", personaId?: string): Promise<GatewaySession> {
    const limit = this.opts.maxSessions ?? 50;
    if (this.sessions.size >= limit) throw new SessionBudgetError(limit);
    const id = randomUUID();
    const engineSession = await this.engine.createSession();
    const context = new BuildOnContext(engineSession);
    const buildOn = new BuildOnSession(engineSession, this.kernel, {
      origin: this.opts.origin ?? "",
      sessionId: id,
      ...(this.rateLimiter ? { rateLimiter: this.rateLimiter } : {}),
      ...(this.perceptionCache ? { cache: this.perceptionCache } : {}),
    });
    const perception = new BuildOnPerceptionAdapter(buildOn);
    const action = new BuildOnActionAdapter(buildOn, perception);

    const session: GatewaySession = {
      id,
      context,
      perception,
      action,
      topology,
      personaId,
      lastSnapshot: undefined,
      subscriptions: new Map(),
      recorder: new TraceRecorder(id, topology),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): GatewaySession | undefined {
    return this.sessions.get(id);
  }

  async destroy(id: string): Promise<SessionTrace | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    for (const cleanup of session.subscriptions.values()) cleanup();
    try {
      return session.recorder.finish();
    } finally {
      await session.context.close().catch(() => undefined);
    }
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Store imported persona cookies (human-initiated, prohibited tier). agent-
   * browser restores them via its own profile/state on a persistent session; the
   * values never reach the model. Merges into any existing import.
   */
  importPersona(personaId: string, cookies: SnapshotData["cookies"]): number {
    const prev = this.personaCookies.get(personaId) ?? [];
    this.personaCookies.set(personaId, [...prev, ...cookies]);
    return cookies.length;
  }

  listPersonas(): PersonaInfo[] {
    const ids = new Set<string>(this.personaCookies.keys());
    const live = new Map<string, number>();
    for (const s of this.sessions.values()) {
      if (s.personaId) { ids.add(s.personaId); live.set(s.personaId, (live.get(s.personaId) ?? 0) + 1); }
    }
    return Array.from(ids).map((personaId) => {
      const cookies = this.personaCookies.get(personaId) ?? [];
      const origins = Array.from(new Set(cookies.map((c) => c.domain).filter((d): d is string => !!d)));
      return { personaId, origins, sessions: live.get(personaId) ?? 0 };
    });
  }

  async destroyAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.sessions.keys()).map((id) => this.destroy(id)));
    await this.engine.shutdown().catch(() => undefined);
  }
}
