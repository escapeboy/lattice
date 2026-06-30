/**
 * AgentBrowserEngine — implements the semantic engine port (ADR 0002) by driving
 * the internal agent-browser process. Maps Lattice's semantic vocabulary onto
 * agent-browser's CLI (open/snapshot/find/click/fill/select/read) and parses its
 * {success,data,error} envelopes into typed results.
 */

import { randomUUID } from "node:crypto";
import { AgentBrowserProcess } from "./process.js";
import type {
  AbEnvelope,
  AbRunner,
  ActionResult,
  EngineLaunchConfig,
  EngineSession,
  EngineSessionId,
  IGRefNode,
  Locator,
  NavResult,
  RawSnapshot,
  SemanticAction,
  SemanticEngine,
  SnapshotOpts,
} from "./types.js";

/** Translate a Locator into the agent-browser selector / find-invocation form. */
function locatorToFind(loc: Locator): { useFind: boolean; locator?: string; value?: string; selector?: string } {
  if (loc.kind === "ref") return { useFind: false, selector: `@${loc.ref}` };
  return { useFind: true, locator: loc.kind, value: loc.value };
}

class AgentBrowserSession implements EngineSession {
  readonly id: EngineSessionId;
  private lastUrl = "";

  constructor(
    private readonly runner: AbRunner,
    id: string,
    /** Bounded navigation settle budget (ms). 0/undefined → wait unbounded (legacy). */
    private readonly settleBudgetMs = 0,
  ) {
    this.id = id as EngineSessionId;
  }

  async navigate(url: string): Promise<NavResult> {
    // BOUNDED SETTLE: a continuous-render canvas/WebGL, infinite-scroll, or polling
    // page never reaches the engine's quiescence, so `open` would block until the
    // hard SIGKILL — looking like a hang and then THROWING. Race the engine call
    // against the settle budget: if the budget elapses first, DEGRADE (resolve a
    // not-settled result) instead of hanging/throwing. The DOM is almost certainly
    // loaded; the caller escalates to an L3 screenshot and the session stays alive.
    // A genuine failure (egress block, DNS, ERR_*) returns a failed envelope FAST,
    // well inside the budget, so `fail()` still throws it — the degrade path is the
    // settle TIMEOUT alone, never a real error.
    const outcome = await withSettleBudget(
      this.runner.run(this.id, "open", [url]),
      this.settleBudgetMs,
    );
    if (outcome.kind === "timeout") {
      this.lastUrl = url;
      return { url, title: "", settled: false };
    }
    const env = outcome.value;
    fail(env, "navigate");
    const landed = str(env.data?.["url"]) ?? url;
    this.lastUrl = landed;
    return { url: landed, title: str(env.data?.["title"]) ?? "", settled: true };
  }

  async currentUrl(): Promise<string> {
    const env = await this.runner.run(this.id, "get", ["url"]);
    const url = str(env.data?.["url"]);
    if (url) this.lastUrl = url;
    return url ?? this.lastUrl;
  }

  async snapshot(opts: SnapshotOpts = {}): Promise<RawSnapshot> {
    const args: string[] = [];
    if (opts.interactive ?? true) args.push("-i");
    if (opts.compact) args.push("-c");
    if (opts.depth !== undefined) args.push("-d", String(opts.depth));
    const env = await this.runner.run(this.id, "snapshot", args);
    fail(env, "snapshot");
    const refsRaw = (env.data?.["refs"] as Record<string, { name?: string; role?: string }>) ?? {};
    const refs: IGRefNode[] = Object.entries(refsRaw).map(([ref, v]) => ({
      ref,
      role: v.role ?? "",
      name: v.name ?? "",
    }));
    const url = str(env.data?.["origin"]) ?? str(env.data?.["url"]) ?? this.lastUrl;
    if (url) this.lastUrl = url;
    return { url, refs, tree: str(env.data?.["snapshot"]) ?? "" };
  }

  async readText(): Promise<string> {
    const env = await this.runner.run(this.id, "read", []);
    fail(env, "read");
    return str(env.data?.["content"]) ?? "";
  }

  async screenshot(): Promise<string> {
    // agent-browser writes the PNG to a temp path and returns it; we read that
    // file (internal runtime output) and return base64. This is the engine's own
    // artifact, NOT the firewalled `--allow-file-access` page-file surface.
    const env = await this.runner.run(this.id, "screenshot", []);
    fail(env, "screenshot");
    const path = str(env.data?.["path"]);
    if (!path) throw new Error("agent-browser screenshot returned no path");
    const { readFileSync } = await import("node:fs");
    return readFileSync(path).toString("base64");
  }

  async act(action: SemanticAction): Promise<ActionResult> {
    const env = await this.dispatch(action);
    return {
      ok: env.success,
      url: str(env.data?.["origin"]) ?? str(env.data?.["url"]),
      error: env.error ?? undefined,
    };
  }

  private dispatch(action: SemanticAction): Promise<AbEnvelope> {
    switch (action.type) {
      case "wait":
        return this.runner.run(this.id, "wait", [String(action.ms)]);
      case "scroll":
        return this.runner.run(
          this.id,
          "scroll",
          action.px !== undefined ? [action.direction, String(action.px)] : [action.direction],
        );
      case "click":
      case "submit": // submit is realized by activating the submit control (trusted input)
        return this.targeted(action.target, "click", []);
      case "hover":
        return this.targeted(action.target, "hover", []);
      case "scrollIntoView":
        return this.targeted(action.target, "scrollintoview", []);
      case "fill":
        return this.targeted(action.target, "fill", [action.value]);
      case "type":
        return this.targeted(action.target, "type", [action.value]);
      case "select":
        return this.targeted(action.target, "select", action.values);
    }
  }

  /**
   * Run a verb against a target. Ref targets use the direct command form
   * (`click @e1`); semantic locators use the `find <locator> <value> <verb>`
   * form, where trailing args become find's text/value argument.
   */
  private targeted(target: Locator, verb: string, trailing: readonly string[]): Promise<AbEnvelope> {
    const t = locatorToFind(target);
    if (!t.useFind) {
      return this.runner.run(this.id, verb, [t.selector as string, ...trailing]);
    }
    return this.runner.run(this.id, "find", [t.locator as string, t.value as string, verb, ...trailing]);
  }

  async close(): Promise<void> {
    await this.runner.run(this.id, "close", []);
  }
}

/**
 * Default bounded navigation settle budget (ms). A continuous-render / non-quiescing
 * page degrades to a not-settled NavResult after this, instead of hanging to the
 * hard SIGKILL. Configurable via the engine options (serve wires an env knob).
 */
export const DEFAULT_SETTLE_BUDGET_MS = 12_000;
/** Grace added on top of the settle budget for agent-browser's own internal
 *  timeout, so an abandoned navigation cleans up just after we've degraded. */
const ENGINE_TIMEOUT_GRACE_MS = 4_000;

export interface AgentBrowserEngineOptions {
  /** Inject a runner (tests). Defaults to a real AgentBrowserProcess. */
  runner?: AbRunner;
  /** Per-command HARD timeout (ms) — the SIGKILL backstop for the default runner. */
  timeoutMs?: number;
  /**
   * Bounded navigation settle budget (ms). After this, `navigate` resolves a
   * not-settled NavResult rather than blocking until the hard timeout. Default
   * {@link DEFAULT_SETTLE_BUDGET_MS}. Set 0 to restore the legacy unbounded wait.
   */
  settleBudgetMs?: number;
}

export class AgentBrowserEngine implements SemanticEngine {
  private runner: AbRunner | undefined;
  private readonly injected: AbRunner | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly settleBudgetMs: number;
  private readonly sessions = new Set<string>();
  private device: string | undefined;

  constructor(opts: AgentBrowserEngineOptions = {}) {
    this.injected = opts.runner;
    this.timeoutMs = opts.timeoutMs;
    this.settleBudgetMs = opts.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS;
  }

  launch(config: EngineLaunchConfig = {}): Promise<void> {
    this.device = config.device;
    if (this.injected) {
      this.runner = this.injected;
    } else {
      this.runner = new AgentBrowserProcess({
        baseFlags: config.headed ? ["--headed"] : [],
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
        // Bound agent-browser's own wait just above our settle budget so an
        // abandoned (degraded) navigation returns control promptly.
        ...(this.settleBudgetMs > 0
          ? { engineActionTimeoutMs: this.settleBudgetMs + ENGINE_TIMEOUT_GRACE_MS }
          : {}),
        ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
      });
    }
    return Promise.resolve();
  }

  async createSession(): Promise<EngineSession> {
    if (!this.runner) throw new Error("Engine not launched; call launch() first.");
    // Private, unguessable session name → the internal-only boundary. Nothing
    // outside this process knows it, and no port is opened for it.
    const id = `lattice-${randomUUID()}`;
    this.sessions.add(id);
    // Apply device emulation for the session (S9 mobile). `set` is a benign
    // emulation setting, not a firewalled primitive.
    if (this.device) await this.runner.run(id, "set", ["device", this.device]);
    return new AgentBrowserSession(this.runner, id, this.settleBudgetMs);
  }

  async shutdown(): Promise<void> {
    if (!this.runner) return;
    for (const id of this.sessions) {
      await this.runner.run(id, "close", []).catch(() => undefined);
    }
    this.sessions.clear();
    this.runner = undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fail(env: AbEnvelope, op: string): void {
  if (!env.success) throw new Error(`agent-browser ${op} failed: ${env.error ?? "unknown error"}`);
}

type SettleOutcome<T> = { kind: "value"; value: T } | { kind: "timeout" };

/**
 * Resolve `p`'s value if it arrives within `budgetMs`; otherwise resolve a
 * `timeout` marker WITHOUT rejecting. The in-flight command is left to finish on
 * its own (under agent-browser's internal timeout + the runner's hard SIGKILL) —
 * its eventual rejection is swallowed so it can't surface as an unhandled
 * rejection. `budgetMs <= 0` disables the bound (await `p` directly). A `p` that
 * REJECTS inside the budget propagates the rejection (a real engine error must
 * still throw — only a settle TIMEOUT degrades).
 */
function withSettleBudget<T>(p: Promise<T>, budgetMs: number): Promise<SettleOutcome<T>> {
  if (!(budgetMs > 0)) return p.then((value) => ({ kind: "value", value }));
  return new Promise<SettleOutcome<T>>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ kind: "timeout" });
    }, budgetMs);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ kind: "value", value });
      },
      (err: unknown) => {
        if (done) return; // already degraded on timeout — swallow the late rejection
        done = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
