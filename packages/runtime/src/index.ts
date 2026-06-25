/**
 * @lattice/runtime — Concurrency runtime + scheduler (S0 scaffold; implementation in S4)
 */

import type { BrowserContextId } from "@lattice/engine";

export type SessionTopology = "ephemeral" | "persistent" | "pooled";

export interface ResourceBudget {
  maxContexts: number;
  maxMemoryMb: number;
  maxCpuPercent: number;
}

export interface SessionContext {
  readonly id: BrowserContextId;
  readonly topology: SessionTopology;
}

export interface FanOutResult<T> {
  readonly contextId: BrowserContextId;
  readonly result: T;
}

export interface RuntimeScheduler {
  createContext(topology: SessionTopology): Promise<SessionContext>;
  destroyContext(id: BrowserContextId): Promise<void>;
  fanOut<T>(
    count: number,
    task: (ctx: SessionContext) => Promise<T>,
  ): Promise<ReadonlyArray<FanOutResult<T>>>;
  snapshot(id: BrowserContextId): Promise<Uint8Array>;
  restore(snapshot: Uint8Array): Promise<SessionContext>;
  activeCount(): number;
}

export function createRuntimeScheduler(_budget: ResourceBudget): RuntimeScheduler {
  void _budget;
  throw new Error("Not implemented — see S4");
}
