/**
 * @lattice/sdk-ts — TypeScript SDK for agent developers (S0 scaffold; implementation in S6)
 *
 * Thin wrapper over the gateway MCP tools, exposing a typed, ergonomic API
 * for agents written in TypeScript/Node.
 */

import type { FidelityTier } from "@lattice/perception";
import type { ActionCommand } from "@lattice/action";

export interface LatticeClientConfig {
  /** Gateway endpoint: "stdio" | "http://host:port" */
  endpoint: string;
  /** Auth token for HTTP transport; omit for stdio */
  token?: string;
}

export interface LatticeSession {
  readonly sessionId: string;
  perceive(tier?: FidelityTier): Promise<unknown>;
  act(command: ActionCommand): Promise<unknown>;
  extract(query: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface LatticeClient {
  connect(): Promise<void>;
  session(topology?: "ephemeral" | "persistent"): Promise<LatticeSession>;
  disconnect(): Promise<void>;
}

export function createClient(_config: LatticeClientConfig): LatticeClient {
  void _config;
  throw new Error("Not implemented — see S6");
}

export { type FidelityTier } from "@lattice/perception";
export { type ActionCommand } from "@lattice/action";
