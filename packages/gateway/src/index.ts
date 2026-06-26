/**
 * @lattice/gateway — Agent Gateway (MCP stdio + HTTP/SSE).
 *
 * Public API:
 *   createAgentGateway(config) → GatewayServer  — factory used by the CLI and tests
 */

import type { EngineAdapter } from "@lattice/engine";
import type { SemanticEngine } from "@lattice/engine-adapter";
import type { SecurityKernel } from "@lattice/kernel";
import { GatewayServer } from "./server.js";
import { BuildOnSessionRegistry } from "./build-on-registry.js";
import type { BuildOnRegistryOptions } from "./build-on-registry.js";
import type { NotificationTransport } from "./handoff.js";
import type { GatewayObserver } from "./server.js";
import type { Vault } from "./vault.js";

export { GatewayServer } from "./server.js";
export type { GatewayObserver, SessionViewEvent } from "./server.js";
export { Vault } from "./vault.js";
export { SessionRegistry } from "./sessions.js";
export type { GatewaySession } from "./sessions.js";
export { BuildOnSession } from "./build-on-session.js";
export type { BuildOnSessionContext } from "./build-on-session.js";
export { BuildOnPerceptionAdapter, BuildOnActionAdapter } from "./build-on-engine.js";
export { BuildOnContext } from "./build-on-context.js";
export { BuildOnSessionRegistry, SessionBudgetError } from "./build-on-registry.js";
export type { BuildOnRegistryOptions } from "./build-on-registry.js";
export { fanOut } from "./build-on-fanout.js";
export type { FanOutResult } from "./build-on-fanout.js";
export { OperatorStore } from "./operator.js";
export type { DeviceRecord, PersonaRecord, PolicySnapshot } from "./operator.js";
export {
  HandoffManager,
  NtfyTransport,
  NullTransport,
} from "./handoff.js";
export type {
  HandoffRequest,
  HandoffStatus,
  HandoffType,
  NotificationTransport,
} from "./handoff.js";

export interface GatewayConfig {
  /** Launched EngineAdapter (caller is responsible for engine.launch() before passing). */
  engine: EngineAdapter;
  /** Configured SecurityKernel. */
  kernel: SecurityKernel;
  /** Handoff notification channel — defaults to NullTransport (no push wired). */
  handoffTransport?: NotificationTransport;
  /** HMAC key the control plane signs input handoffs with. */
  handoffSigningKey?: string;
  /** Encrypted/persisted vault (defaults to an in-memory one). */
  vault?: Vault;
  /** Lifecycle/trace/grant hooks the unified `serve` wires to the control plane. */
  observer?: GatewayObserver;
}

export function createAgentGateway(config: GatewayConfig): GatewayServer {
  return new GatewayServer(config.engine, config.kernel, {
    ...(config.handoffTransport ? { handoffTransport: config.handoffTransport } : {}),
    ...(config.handoffSigningKey ? { handoffSigningKey: config.handoffSigningKey } : {}),
    ...(config.vault ? { vault: config.vault } : {}),
    ...(config.observer ? { observer: config.observer } : {}),
  });
}

export interface BuildOnGatewayConfig {
  /** A launched build-on SemanticEngine (agent-browser); the agent never holds it. */
  engine: SemanticEngine;
  kernel: SecurityKernel;
  handoffTransport?: NotificationTransport;
  handoffSigningKey?: string;
  vault?: Vault;
  observer?: GatewayObserver;
  /** Task origin scope passed to the governed build-on sessions. */
  registry?: BuildOnRegistryOptions;
}

/**
 * Build the gateway on the build-on stack (ADR 0002): sessions run agent-browser
 * behind the governed BuildOnSession instead of CDP. Same MCP surface, same
 * tools — only the engine substrate differs.
 */
export function createBuildOnGateway(config: BuildOnGatewayConfig): GatewayServer {
  const provider = new BuildOnSessionRegistry(config.engine, config.kernel, config.registry ?? {});
  return new GatewayServer(null, config.kernel, {
    sessionProvider: provider,
    ...(config.handoffTransport ? { handoffTransport: config.handoffTransport } : {}),
    ...(config.handoffSigningKey ? { handoffSigningKey: config.handoffSigningKey } : {}),
    ...(config.vault ? { vault: config.vault } : {}),
    ...(config.observer ? { observer: config.observer } : {}),
  });
}
