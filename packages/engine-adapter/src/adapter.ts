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

  constructor(private readonly runner: AbRunner, id: string) {
    this.id = id as EngineSessionId;
  }

  async navigate(url: string): Promise<NavResult> {
    const env = await this.runner.run(this.id, "open", [url]);
    fail(env, "navigate");
    const landed = str(env.data?.["url"]) ?? url;
    this.lastUrl = landed;
    return { url: landed, title: str(env.data?.["title"]) ?? "" };
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

export interface AgentBrowserEngineOptions {
  /** Inject a runner (tests). Defaults to a real AgentBrowserProcess. */
  runner?: AbRunner;
  /** Per-command timeout (ms) for the default runner. */
  timeoutMs?: number;
}

export class AgentBrowserEngine implements SemanticEngine {
  private runner: AbRunner | undefined;
  private readonly injected: AbRunner | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly sessions = new Set<string>();
  private device: string | undefined;

  constructor(opts: AgentBrowserEngineOptions = {}) {
    this.injected = opts.runner;
    this.timeoutMs = opts.timeoutMs;
  }

  launch(config: EngineLaunchConfig = {}): Promise<void> {
    this.device = config.device;
    if (this.injected) {
      this.runner = this.injected;
    } else {
      this.runner = new AgentBrowserProcess({
        baseFlags: config.headed ? ["--headed"] : [],
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
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
    return new AgentBrowserSession(this.runner, id);
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
