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
import type { SnapshotData } from "@lattice/runtime";
import { BuildOnSession } from "./build-on-session.js";
import { BuildOnContext } from "./build-on-context.js";
import { BuildOnPerceptionAdapter, BuildOnActionAdapter } from "./build-on-engine.js";
import type { GatewaySession, SessionProvider, SessionTopology } from "./sessions.js";
import { randomUUID } from "node:crypto";

export interface BuildOnRegistryOptions {
  /** Task origin scope for the governed session (default: unrestricted dev). */
  origin?: string;
}

export class BuildOnSessionRegistry implements SessionProvider {
  private readonly sessions = new Map<string, GatewaySession>();
  /** Imported persona cookies, keyed by personaId (S8.5 persistence glue). */
  private readonly personaCookies = new Map<string, SnapshotData["cookies"]>();

  constructor(
    private readonly engine: SemanticEngine,
    private readonly kernel: SecurityKernel,
    private readonly opts: BuildOnRegistryOptions = {},
  ) {}

  async create(topology: SessionTopology = "ephemeral", personaId?: string): Promise<GatewaySession> {
    const id = randomUUID();
    const engineSession = await this.engine.createSession();
    const context = new BuildOnContext(engineSession);
    const buildOn = new BuildOnSession(engineSession, this.kernel, {
      origin: this.opts.origin ?? "",
      sessionId: id,
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

  async destroyAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.sessions.keys()).map((id) => this.destroy(id)));
    await this.engine.shutdown().catch(() => undefined);
  }
}
