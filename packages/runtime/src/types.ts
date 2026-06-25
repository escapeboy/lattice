/**
 * Concurrency Runtime public types.
 */

import type { BrowserContextId, ContextHandle } from "@lattice/engine";

export type { BrowserContextId, ContextHandle };

export type SessionTopology = "ephemeral" | "persistent" | "pooled";

export interface ResourceBudget {
  maxContexts: number;
  maxMemoryMb: number;
  maxCpuPercent: number;
}

export interface ContextSlot {
  readonly context: ContextHandle;
  readonly topology: SessionTopology;
  readonly createdAt: number;
}

export interface FanOutResult<T> {
  readonly contextId: BrowserContextId;
  readonly result: T;
  readonly error?: Error;
}

export interface SnapshotData {
  readonly cookies: ReadonlyArray<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
    expires?: number;
  }>;
  readonly localStorage: Readonly<Record<string, string>>;
  readonly sessionStorage: Readonly<Record<string, string>>;
  readonly currentUrl: string;
}

export interface RuntimeScheduler {
  createContext(topology: SessionTopology): Promise<ContextHandle>;
  destroyContext(id: BrowserContextId): Promise<void>;
  fanOut<T>(
    count: number,
    task: (ctx: ContextHandle) => Promise<T>,
  ): Promise<ReadonlyArray<FanOutResult<T>>>;
  snapshotContext(id: BrowserContextId): Promise<SnapshotData>;
  restoreContext(snapshot: SnapshotData): Promise<ContextHandle>;
  activeCount(): number;
  shutdown(): Promise<void>;
}
