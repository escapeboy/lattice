/**
 * Session registry — maps sessionId → live browser context + engines.
 */

import { randomUUID } from "node:crypto";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { PerceptionEngine, InteractionGraph } from "@lattice/perception";
import { createActionEngine } from "@lattice/action";
import type { ActionEngine } from "@lattice/action";
import type { SecurityKernel } from "@lattice/kernel";
import { RuntimeSchedulerImpl, type ResourceBudget, type SnapshotData } from "@lattice/runtime";
import { TraceRecorder } from "@lattice/observability";
import type { SessionTrace } from "@lattice/observability";

export type SessionTopology = "ephemeral" | "persistent";

/**
 * The session surface GatewayServer depends on. Both the CDP SessionRegistry and
 * the build-on registry (ADR 0002) implement it, so the server drives either
 * engine unchanged (dual-stack).
 */
/** Operator read surface: a persona's identity + scope, never its stored state/values. */
export interface PersonaInfo {
  personaId: string;
  origins: string[];
  sessions: number;
}

export interface SessionProvider {
  create(topology?: SessionTopology, personaId?: string): Promise<GatewaySession>;
  get(id: string): GatewaySession | undefined;
  destroy(id: string): Promise<SessionTrace | undefined>;
  list(): string[];
  activeCount(): number;
  importPersona(personaId: string, cookies: SnapshotData["cookies"]): number;
  /** Known personas (imported state + live persistent sessions). Read-only, no values. */
  listPersonas(): PersonaInfo[];
  destroyAll(): Promise<void>;
}

export interface GatewaySession {
  readonly id: string;
  readonly context: ContextHandle;
  readonly perception: PerceptionEngine;
  readonly action: ActionEngine;
  readonly topology: SessionTopology;
  /** Persona this session operates as (persistent topology persists its state). */
  readonly personaId: string | undefined;
  /** Last L1 snapshot — used for delta computation. */
  lastSnapshot: InteractionGraph | undefined;
  /** Active delta subscriptions (intervalId → cleanup fn). */
  readonly subscriptions: Map<string, () => void>;
  /** Trace recorder for this session. */
  readonly recorder: TraceRecorder;
}

const DEFAULT_BUDGET: ResourceBudget = { maxContexts: 50, maxMemoryMb: 4096, maxCpuPercent: 90 };

/**
 * Session registry on the S4 scheduler: contexts are acquired under a resource
 * budget (the governor), and `persistent` personas keep their cookies/storage
 * across sessions (snapshot on teardown, restore on re-create).
 */
export class SessionRegistry implements SessionProvider {
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly scheduler: RuntimeSchedulerImpl;
  /** Per-persona saved state, keyed by personaId (persistent topology). */
  private readonly personaState = new Map<string, SnapshotData>();

  constructor(
    engine: EngineAdapter,
    private readonly kernel: SecurityKernel,
    budget: ResourceBudget = DEFAULT_BUDGET,
  ) {
    this.scheduler = new RuntimeSchedulerImpl(engine, budget);
  }

  async create(
    topology: SessionTopology = "ephemeral",
    personaId?: string,
  ): Promise<GatewaySession> {
    // Persistent persona with saved state → restore cookies/storage into a
    // fresh context so the agent operates as the already-logged-in persona.
    const saved = topology === "persistent" && personaId ? this.personaState.get(personaId) : undefined;
    const ctx = saved
      ? await this.scheduler.restoreContext(saved)
      : await this.scheduler.createContext(topology);

    const perception = createPerceptionEngine(ctx.cdp());
    const action = createActionEngine(ctx.cdp(), ctx, perception);

    const id = randomUUID();
    const session: GatewaySession = {
      id,
      context: ctx,
      perception,
      action,
      topology,
      personaId,
      lastSnapshot: undefined,
      subscriptions: new Map(),
      recorder: new TraceRecorder(id, topology),
    };
    this.sessions.set(session.id, session);
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
      // Persist persona state before teardown so the next session resumes it.
      if (session.topology === "persistent" && session.personaId) {
        const snap = await this.scheduler.snapshotContext(session.context.id).catch(() => undefined);
        if (snap) this.personaState.set(session.personaId, snap);
      }
      return session.recorder.finish(); // finalize trace
    } finally {
      // The context is ALWAYS released, even if snapshot/finish threw — no leak.
      await this.scheduler.destroyContext(session.context.id).catch(() => undefined);
    }
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Live context count under the governor (for budget visibility). */
  activeCount(): number {
    return this.scheduler.activeCount();
  }

  /**
   * Seed a persona's persistent state from imported cookies (human persona
   * import). The next `persistent` session for this persona restores them, so
   * the agent operates as the already-logged-in human — without ever seeing the
   * values. Merges into any existing snapshot.
   */
  importPersona(personaId: string, cookies: SnapshotData["cookies"]): number {
    const prev = this.personaState.get(personaId);
    const merged: SnapshotData = {
      cookies: [...(prev?.cookies ?? []), ...cookies],
      localStorage: prev?.localStorage ?? {},
      sessionStorage: prev?.sessionStorage ?? {},
      currentUrl: prev?.currentUrl ?? "",
    };
    this.personaState.set(personaId, merged);
    return cookies.length;
  }

  listPersonas(): PersonaInfo[] {
    const ids = new Set<string>(this.personaState.keys());
    const live = new Map<string, number>();
    for (const s of this.sessions.values()) {
      if (s.personaId) { ids.add(s.personaId); live.set(s.personaId, (live.get(s.personaId) ?? 0) + 1); }
    }
    return Array.from(ids).map((personaId) => {
      const cookies = this.personaState.get(personaId)?.cookies ?? [];
      const origins = Array.from(new Set(cookies.map((c) => c.domain).filter((d): d is string => !!d)));
      return { personaId, origins, sessions: live.get(personaId) ?? 0 };
    });
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }
}
