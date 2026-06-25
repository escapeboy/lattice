/**
 * RuntimeScheduler implementation — manages N isolated browser contexts
 * under a resource budget with fan-out and snapshot/restore.
 */

import type { BrowserContextId, ContextHandle, EngineAdapter } from "@lattice/engine";
import type {
  ContextSlot,
  FanOutResult,
  ResourceBudget,
  RuntimeScheduler,
  SessionTopology,
  SnapshotData,
} from "./types.js";

interface CookieResult {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
    expires?: number;
  }>;
}

interface StorageResult {
  result: { value: string };
}

export class RuntimeSchedulerImpl implements RuntimeScheduler {
  private readonly slots = new Map<BrowserContextId, ContextSlot>();

  constructor(
    private readonly engine: EngineAdapter,
    private readonly budget: ResourceBudget,
  ) {}

  async createContext(topology: SessionTopology): Promise<ContextHandle> {
    if (this.slots.size >= this.budget.maxContexts) {
      throw new Error(
        `Budget exhausted: maxContexts=${this.budget.maxContexts}, active=${this.slots.size}`,
      );
    }
    const ctx = await this.engine.createContext();
    this.slots.set(ctx.id, { context: ctx, topology, createdAt: Date.now() });
    return ctx;
  }

  async destroyContext(id: BrowserContextId): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    await slot.context.close();
  }

  async fanOut<T>(
    count: number,
    task: (ctx: ContextHandle) => Promise<T>,
  ): Promise<ReadonlyArray<FanOutResult<T>>> {
    const available = this.budget.maxContexts - this.slots.size;
    const actual = Math.min(count, available);
    if (actual <= 0) throw new Error("No context slots available for fan-out");

    const contexts: ContextHandle[] = await Promise.all(
      Array.from({ length: actual }, () => this.createContext("ephemeral")),
    );

    const results = await Promise.allSettled(contexts.map((ctx) => task(ctx)));

    const fanOutResults: FanOutResult<T>[] = results.map((r, i) => {
      const ctx = contexts[i]!;
      if (r.status === "fulfilled") {
        return { contextId: ctx.id, result: r.value };
      }
      return {
        contextId: ctx.id,
        result: undefined as unknown as T,
        error: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
      };
    });

    // Tear down all ephemeral contexts
    await Promise.allSettled(contexts.map((ctx) => this.destroyContext(ctx.id)));

    return fanOutResults;
  }

  async snapshotContext(id: BrowserContextId): Promise<SnapshotData> {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`Context ${id} not found`);
    const { context: ctx } = slot;
    const cdp = ctx.cdp();

    // Cookies via Network domain
    const { cookies } = await cdp.send<CookieResult>("Network.getAllCookies", {});

    // localStorage
    const lsResult = await cdp.send<StorageResult>("Runtime.evaluate", {
      expression: "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))",
      returnByValue: true,
    }).catch(() => ({ result: { value: "{}" } }));

    // sessionStorage
    const ssResult = await cdp.send<StorageResult>("Runtime.evaluate", {
      expression: "JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))",
      returnByValue: true,
    }).catch(() => ({ result: { value: "{}" } }));

    const localStorage = JSON.parse(lsResult.result.value ?? "{}") as Record<string, string>;
    const sessionStorage = JSON.parse(ssResult.result.value ?? "{}") as Record<string, string>;

    return {
      cookies,
      localStorage,
      sessionStorage,
      currentUrl: ctx.currentUrl(),
    };
  }

  async restoreContext(snapshot: SnapshotData): Promise<ContextHandle> {
    const ctx = await this.createContext("persistent");
    const cdp = ctx.cdp();

    // Restore cookies
    for (const cookie of snapshot.cookies) {
      await cdp.send("Network.setCookie", cookie).catch(() => {
        // Ignore cookie errors (cross-origin, expired, etc.)
      });
    }

    // Navigate to the snapshotted URL first so storage APIs work on the right origin
    if (snapshot.currentUrl && !snapshot.currentUrl.startsWith("about:")) {
      await ctx.navigate(snapshot.currentUrl);
    }

    // Restore localStorage
    if (Object.keys(snapshot.localStorage).length > 0) {
      await cdp.send("Runtime.evaluate", {
        expression: `
          (function() {
            const data = ${JSON.stringify(snapshot.localStorage)};
            Object.entries(data).forEach(([k,v]) => localStorage.setItem(k,v));
          })()
        `,
      }).catch(() => {});
    }

    // Restore sessionStorage
    if (Object.keys(snapshot.sessionStorage).length > 0) {
      await cdp.send("Runtime.evaluate", {
        expression: `
          (function() {
            const data = ${JSON.stringify(snapshot.sessionStorage)};
            Object.entries(data).forEach(([k,v]) => sessionStorage.setItem(k,v));
          })()
        `,
      }).catch(() => {});
    }

    return ctx;
  }

  activeCount(): number {
    return this.slots.size;
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.slots.keys());
    await Promise.allSettled(ids.map((id) => this.destroyContext(id)));
  }
}
