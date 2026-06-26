/**
 * @lattice/engine-adapter — build-on engine layer (ADR 0002).
 *
 * Wraps vercel-labs/agent-browser (Apache-2.0) as an internal-only engine behind
 * a narrow semantic surface. agent-browser supplies the hands and eyes; Lattice
 * is the only door to them, and that door enforces the constitution. See NOTICE
 * for attribution.
 */

export { AgentBrowserEngine } from "./adapter.js";
export type { AgentBrowserEngineOptions } from "./adapter.js";
export { AgentBrowserProcess, resolveAgentBrowserBinary, parseEnvelope } from "./process.js";
export type { ProcessOptions } from "./process.js";
export {
  EngineFirewallError,
  assertNotFirewalled,
  FIREWALLED_SUBCOMMANDS,
  FIREWALLED_FLAGS,
  FIREWALLED_GET_TARGETS,
} from "./firewall.js";
export type {
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
