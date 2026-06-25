/**
 * @lattice/gateway — MCP server (stdio + HTTP/SSE) (S0 scaffold; implementation in S6)
 */

import type { FidelityTier, InteractionGraph, IGDelta } from "@lattice/perception";
import type { ActionCommand, ActionResult } from "@lattice/action";
import type { BrowserContextId } from "@lattice/engine";

export type TransportType = "stdio" | "http-sse";

export interface GatewayConfig {
  transport: TransportType;
  port?: number;
  host?: string;
}

export interface SessionHandle {
  readonly id: BrowserContextId;
}

/** MCP tool groups exposed by the gateway */
export interface GatewayTools {
  // session.*
  "session.create"(topology: "ephemeral" | "persistent"): Promise<SessionHandle>;
  "session.destroy"(id: BrowserContextId): Promise<void>;

  // perceive.*
  "perceive.snapshot"(id: BrowserContextId, tier: FidelityTier): Promise<InteractionGraph>;
  "perceive.subscribe"(id: BrowserContextId, tier: FidelityTier): AsyncIterable<IGDelta>;

  // act.*
  "act.execute"(id: BrowserContextId, command: ActionCommand): Promise<ActionResult>;

  // extract.*
  "extract.query"(id: BrowserContextId, query: string): Promise<unknown>;

  // policy.*
  "policy.list"(): Promise<ReadonlyArray<{ id: string; description: string }>>;
}

export interface AgentGateway {
  start(config: GatewayConfig): Promise<void>;
  stop(): Promise<void>;
  readonly tools: GatewayTools;
}

export function createAgentGateway(): AgentGateway {
  throw new Error("Not implemented — see S6");
}
