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
import { TraceRecorder } from "@lattice/observability";

export interface GatewaySession {
  readonly id: string;
  readonly context: ContextHandle;
  readonly perception: PerceptionEngine;
  readonly action: ActionEngine;
  /** Last L1 snapshot — used for delta computation. */
  lastSnapshot: InteractionGraph | undefined;
  /** Active delta subscriptions (intervalId → cleanup fn). */
  readonly subscriptions: Map<string, () => void>;
  /** Trace recorder for this session. */
  readonly recorder: TraceRecorder;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, GatewaySession>();

  constructor(
    private readonly engine: EngineAdapter,
    private readonly kernel: SecurityKernel,
  ) {}

  async create(topology: "ephemeral" | "persistent" = "ephemeral"): Promise<GatewaySession> {
    void topology; // topology influences warm-pool in S4 runtime; gateway uses engine directly
    const ctx = await this.engine.createContext();
    const perception = createPerceptionEngine(ctx.cdp());
    const action = createActionEngine(ctx.cdp(), ctx, perception);

    const id = randomUUID();
    const session: GatewaySession = {
      id,
      context: ctx,
      perception,
      action,
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

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const cleanup of session.subscriptions.values()) cleanup();
    session.recorder.finish(); // finalize trace
    this.sessions.delete(id);
    await session.context.close();
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }
}
