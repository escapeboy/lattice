/**
 * @lattice/serve — the unified process. One SecurityKernel, one HandoffManager,
 * one Vault; two faces: the MCP gateway (agents) and the control plane (humans).
 *
 * Realizes "UI and MCP share one policy/grant/audit slice": the control plane's
 * grant inbox mints on the SAME kernel the gateway gates against, session
 * lifecycle flows into the live theater, traces flow into the replay browser,
 * and handoffs raised by the agent are resolvable from the control-plane UI.
 */

import { createAgentGateway, type GatewayServer, type NotificationTransport, type Vault } from "@lattice/gateway";
import type { EngineAdapter } from "@lattice/engine";
import type { SecurityKernel } from "@lattice/kernel";
import { ControlPlaneServer } from "@lattice/control-plane";
import { emitToSvod, type SvodWriteFn } from "@lattice/observability";

export interface LatticeCore {
  gateway: GatewayServer;
  control: ControlPlaneServer;
}

export interface LatticeServeConfig {
  engine: EngineAdapter;
  kernel: SecurityKernel;
  handoffTransport?: NotificationTransport;
  handoffSigningKey?: string;
  vault?: Vault;
  /** Where finished traces are emitted (Svod note). File writer by default. */
  traceWriter?: SvodWriteFn;
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

  const gateway = createAgentGateway({
    engine: config.engine,
    kernel: config.kernel,
    ...(config.handoffTransport ? { handoffTransport: config.handoffTransport } : {}),
    ...(config.handoffSigningKey ? { handoffSigningKey: config.handoffSigningKey } : {}),
    ...(config.vault ? { vault: config.vault } : {}),
    observer: {
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
        if (config.traceWriter) {
          void emitToSvod(trace, config.traceWriter).catch(() => { /* logged upstream */ });
        }
      },
      onGrantRequest: (scope, summary) => ref.control?.requestOperatorGrant(scope, summary),
    },
  });

  const control = new ControlPlaneServer(undefined, {
    kernel: config.kernel,
    handoffs: gateway.handoffs,
    submitHandoffInput: (handoffId, deviceId, sessionId, fieldNodeId, value) =>
      gateway.submitHandoffInput(handoffId, deviceId, sessionId, fieldNodeId, value),
  });
  ref.control = control;

  return { gateway, control };
}
