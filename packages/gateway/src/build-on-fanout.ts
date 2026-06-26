/**
 * Fan-out over the build-on stack (ADR 0002, S4): one task → many governed
 * sessions, one aggregation. Each item gets its own BuildOnSession-backed
 * GatewaySession under the registry's resource governor; the worker perceives /
 * acts; sessions are always torn down (trace finalized) even on failure.
 */

import type { GatewaySession } from "./sessions.js";
import { BuildOnSessionRegistry, SessionBudgetError } from "./build-on-registry.js";

export interface FanOutResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

/**
 * Run `worker` across `items` on concurrent governed sessions, bounded by the
 * registry's session cap (excess items wait for a slot). Returns one result per
 * item, in input order; a worker that throws yields { ok:false, error }.
 */
export async function fanOut<I, T>(
  registry: BuildOnSessionRegistry,
  items: readonly I[],
  worker: (session: GatewaySession, item: I, index: number) => Promise<T>,
  opts: { concurrency?: number } = {},
): Promise<Array<FanOutResult<T>>> {
  const concurrency = Math.max(1, opts.concurrency ?? items.length);
  const results = new Array<FanOutResult<T>>(items.length);
  let next = 0;

  async function runOne(index: number): Promise<void> {
    const item = items[index] as I;
    let session: GatewaySession | undefined;
    try {
      session = await registry.create("ephemeral");
      const value = await worker(session, item, index);
      results[index] = { ok: true, value };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results[index] = { ok: false, error };
    } finally {
      if (session) await registry.destroy(session.id).catch(() => undefined);
    }
  }

  async function loop(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await runOne(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => loop()));
  return results;
}

export { SessionBudgetError };
