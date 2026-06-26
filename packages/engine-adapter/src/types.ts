/**
 * Build-on engine port (ADR 0002).
 *
 * Lattice consumes the agent-browser engine through THIS semantic surface only.
 * It is deliberately narrow: navigate / snapshot / read / semantic-act / close.
 * There is NO `cdp()`, NO `eval`, NO file or profile access — those agent-browser
 * primitives bypass the Security Kernel and are firewalled at the Lattice layer
 * (see firewall.ts). The absence of a method here IS the structural guarantee:
 * an agent reaching the gateway can never route a kernel-bypassing primitive,
 * because the engine seam does not expose one.
 *
 * Contrast with the legacy CDP-centric `EngineAdapter` (@lattice/engine), whose
 * `cdp()` handle is exactly the escape hatch ADR 0002 §3 closes.
 */

export type EngineSessionId = string & { readonly __brand: "EngineSessionId" };

export interface EngineLaunchConfig {
  /** Run with a visible window (headful + Xvfb on servers; S8.5 persona hardening). */
  headed?: boolean;
  /** Emulate a device for every session (e.g. "iPhone 12") — S9 mobile sanity. */
  device?: string;
  /**
   * Route ALL browser egress through this forward proxy (the Lattice egress
   * firewall). Set as HTTP(S)_PROXY for the agent-browser child, so every
   * outbound request is gated before it leaves. agent-browser stays internal —
   * the proxy is around the engine, not a fork.
   */
  proxyUrl?: string;
}

export interface NavResult {
  /** URL the page actually landed on (engine ground truth). */
  url: string;
  /** Page title, when the engine reports one. */
  title: string;
}

/** A single interactive node from the accessibility snapshot. */
export interface IGRefNode {
  /** agent-browser ref id (e.g. "e1") — stable only within one snapshot. */
  ref: string;
  role: string;
  name: string;
}

export interface RawSnapshot {
  /** Current page origin/url at snapshot time. */
  url: string;
  /** Interactive refs, parsed from the engine's `refs` map. */
  refs: IGRefNode[];
  /** The raw accessibility tree text with [ref=eN] markers (L1/L2 source). */
  tree: string;
}

export interface SnapshotOpts {
  /** Only interactive elements (-i). Defaults to true. */
  interactive?: boolean;
  /** Remove empty structural nodes (-c). */
  compact?: boolean;
  /** Limit tree depth (-d). */
  depth?: number;
}

/** How to address an element: by snapshot ref or by semantic locator. */
export type Locator =
  | { kind: "ref"; ref: string }
  | { kind: "role"; value: string; text?: string }
  | { kind: "text"; value: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "testid"; value: string };

export type SemanticAction =
  | { type: "click"; target: Locator }
  | { type: "fill"; target: Locator; value: string }
  | { type: "type"; target: Locator; value: string }
  | { type: "select"; target: Locator; values: string[] }
  | { type: "submit"; target: Locator }
  | { type: "hover"; target: Locator }
  | { type: "scrollIntoView"; target: Locator }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right"; px?: number }
  | { type: "wait"; ms: number };

export interface ActionResult {
  ok: boolean;
  /** Page url after the action, when the engine reports it. */
  url: string | undefined;
  /** Typed-ish error string from the engine, when the action failed. */
  error: string | undefined;
}

export interface EngineSession {
  readonly id: EngineSessionId;
  navigate(url: string): Promise<NavResult>;
  currentUrl(): Promise<string>;
  snapshot(opts?: SnapshotOpts): Promise<RawSnapshot>;
  /** Agent-readable text of the active page (L2 fidelity). */
  readText(): Promise<string>;
  /** Viewport screenshot as base64-encoded PNG (L3 pixel tier). */
  screenshot(): Promise<string>;
  act(action: SemanticAction): Promise<ActionResult>;
  close(): Promise<void>;
}

export interface SemanticEngine {
  launch(config?: EngineLaunchConfig): Promise<void>;
  createSession(): Promise<EngineSession>;
  shutdown(): Promise<void>;
}

/** The {success,data,error} envelope every agent-browser `--json` command returns. */
export interface AbEnvelope {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

/** Pluggable command runner — the seam tests inject a fake for unit coverage. */
export interface AbRunner {
  run(session: string, subcommand: string, args: readonly string[]): Promise<AbEnvelope>;
}
