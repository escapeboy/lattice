/**
 * @lattice/gateway — Agent Gateway (MCP stdio + HTTP/SSE).
 *
 * Public API:
 *   createAgentGateway(config) → GatewayServer  — factory used by the CLI and tests
 */

import type { EngineAdapter } from "@lattice/engine";
import type { SecurityKernel } from "@lattice/kernel";
import { GatewayServer } from "./server.js";

export { GatewayServer } from "./server.js";
export { Vault } from "./vault.js";
export { SessionRegistry } from "./sessions.js";
export type { GatewaySession } from "./sessions.js";

export interface GatewayConfig {
  /** Launched EngineAdapter (caller is responsible for engine.launch() before passing). */
  engine: EngineAdapter;
  /** Configured SecurityKernel. */
  kernel: SecurityKernel;
}

export function createAgentGateway(config: GatewayConfig): GatewayServer {
  return new GatewayServer(config.engine, config.kernel);
}
