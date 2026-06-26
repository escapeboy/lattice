/**
 * @lattice/serve — the unified process. One SecurityKernel, one HandoffManager,
 * one Vault; two faces: the MCP gateway (agents) and the control plane (humans).
 *
 * Realizes "UI and MCP share one policy/grant/audit slice": the control plane's
 * grant inbox mints on the SAME kernel the gateway gates against, session
 * lifecycle flows into the live theater, traces flow into the replay browser,
 * and handoffs raised by the agent are resolvable from the control-plane UI.
 */

import { createAgentGateway, createBuildOnGateway, type GatewayObserver, type GatewayServer, type NotificationTransport, type Vault } from "@lattice/gateway";
import type { EngineAdapter } from "@lattice/engine";
import type { SemanticEngine } from "@lattice/engine-adapter";
import type { SecurityKernel } from "@lattice/kernel";
import { ControlPlaneServer } from "@lattice/control-plane";
import { emitToSvod, type SvodWriteFn, type PiiPolicy } from "@lattice/observability";
import type { EgressPolicy } from "@lattice/egress-proxy";
import { importChromeCookies } from "./chrome-import.js";

export interface LatticeCore {
  gateway: GatewayServer;
  control: ControlPlaneServer;
}

/**
 * Resolve the engine kind from the LATTICE_ENGINE value. The DEFAULT is the
 * build-on (firewalled) stack — eval/raw-CDP/file are structurally absent there.
 * Only the explicit value "cdp" selects the legacy raw-CDP stack, which lacks
 * the build-on firewall and is dev-only. (A1: no default path bypasses the
 * kernel/tainting/floor guarantees.)
 */
export function resolveEngineKind(engineEnv: string | undefined): "cdp" | "agent-browser" {
  return engineEnv === "cdp" ? "cdp" : "agent-browser";
}

export interface LatticeServeConfig {
  /** Which engine backs the gateway sessions. Default "agent-browser" (build-on, firewalled). */
  engineKind?: "cdp" | "agent-browser";
  /** Launched CDP engine (required for engineKind "cdp"). */
  engine?: EngineAdapter;
  /** Launched build-on engine (required for engineKind "agent-browser", ADR 0002). */
  buildOnEngine?: SemanticEngine;
  kernel: SecurityKernel;
  handoffTransport?: NotificationTransport;
  handoffSigningKey?: string;
  vault?: Vault;
  /** Where finished traces are emitted (Svod note). File writer by default. */
  traceWriter?: SvodWriteFn;
  /** PII redaction policy applied before traces persist to Svod (P1.1). Redacted by default. */
  piiPolicy?: PiiPolicy;
  /** Ask-to-allow egress policy (learn mode): the operator surface reads pending + allows/denies. */
  egressPolicy?: EgressPolicy;
  /** Bearer token required on the control plane's state-changing routes. */
  controlPlaneToken?: string;
  /** Bearer token required on the /mcp endpoint when set (A2). */
  mcpToken?: string;
}

/**
 * Build the gateway and control plane around one shared kernel/handoff, wiring
 * the gateway's observer hooks into the control plane. Returns both; the caller
 * starts whichever transports it wants (HTTP/SSE, stdio).
 */
export function createLatticeCore(config: LatticeServeConfig): LatticeCore {
  // The gateway's observer must reference the control plane, but the control
  // plane's backend references the gateway (its kernel/handoffs) — a mutual
  // dependency. A const holder breaks the cycle: the observer closures read
  // `ref.control`, which is filled in once the gateway exists.
  const ref: { control?: ControlPlaneServer } = {};

  const observer: GatewayObserver = {
    onSession: (sessionId, view) => {
      if (view === null) ref.control?.removeSession(sessionId);
      else ref.control?.updateSession({
        sessionId: view.sessionId,
        url: view.url,
        actionCount: view.actionCount,
        ...(view.nodeCount !== undefined ? { nodeCount: view.nodeCount } : {}),
        ...(view.lastSnapshotAt !== undefined ? { lastSnapshotAt: view.lastSnapshotAt } : {}),
      });
    },
    onTrace: (trace) => {
      ref.control?.submitTrace(trace);
      // Best-effort emit to Svod (or a file writer); never block teardown.
      // PII is redacted at this boundary before the immutable store (P1.1);
      // the full-fidelity trace above stays in the human-side control plane.
      if (config.traceWriter) {
        void emitToSvod(trace, config.traceWriter, undefined, config.piiPolicy).catch(() => { /* logged upstream */ });
      }
    },
    onGrantRequest: (scope, summary) => ref.control?.requestOperatorGrant(scope, summary),
  };

  const shared = {
    kernel: config.kernel,
    observer,
    ...(config.handoffTransport ? { handoffTransport: config.handoffTransport } : {}),
    ...(config.handoffSigningKey ? { handoffSigningKey: config.handoffSigningKey } : {}),
    ...(config.vault ? { vault: config.vault } : {}),
    ...(config.mcpToken ? { mcpToken: config.mcpToken } : {}),
  };

  // Dual-stack engine selection (ADR 0002): the build-on path runs agent-browser
  // behind the governed session; the default CDP path is unchanged.
  let gateway: GatewayServer;
  if (config.engineKind === "agent-browser") {
    if (!config.buildOnEngine) throw new Error('engineKind "agent-browser" requires a launched buildOnEngine');
    gateway = createBuildOnGateway({ engine: config.buildOnEngine, ...shared });
  } else {
    if (!config.engine) throw new Error('engineKind "cdp" requires a launched engine');
    gateway = createAgentGateway({ engine: config.engine, ...shared });
  }

  const control = new ControlPlaneServer(undefined, {
    kernel: config.kernel,
    handoffs: gateway.handoffs,
    submitHandoffInput: (handoffId, deviceId, sessionId, fieldNodeId, value) =>
      gateway.submitHandoffInput(handoffId, deviceId, sessionId, fieldNodeId, value),
    verifyDevice: (deviceId, challenge) => gateway.verifyDevice(deviceId, challenge),
    applyPolicy: (patch) => {
      const p = gateway.applyOperatorPolicy(patch);
      return { allowedOrigins: p.allowedOrigins, egressAllowlist: p.egressAllowlist, prohibitedActions: p.prohibitedActions, requireGrant: p.requireGrant };
    },
    setBudget: (limit) => gateway.setOperatorBudget(limit),
    importPersona: (personaId, profile, origins) => {
      // Read + decrypt the human's Chrome cookies (prompts Keychain), scope by
      // origin, and inject into the persona — values never leave this boundary.
      const cookies = importChromeCookies(profile, origins);
      const imported = gateway.importPersonaCookies(personaId, origins, cookies);
      return Promise.resolve({ imported, origins });
    },
    listPersonas: () => gateway.listPersonas(),
    listVault: () => gateway.listVaultEntries(),
    egressPending: () => config.egressPolicy?.pendingList() ?? [],
    egressAllow: (origin) => config.egressPolicy?.allow(origin),
    egressDeny: (origin) => config.egressPolicy?.deny(origin),
  }, config.controlPlaneToken);
  ref.control = control;

  return { gateway, control };
}
