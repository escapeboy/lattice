/**
 * @lattice/kernel — Security kernel.
 */

export type {
  AuditEvent,
  CapabilityRequest,
  EgressRequest,
  GrantDecision,
  GrantScope,
  KernelConfig,
  OperatorDecision,
  OperatorRequest,
  OperatorTier,
  PolicyClass,
  SecurityKernel,
  TaintedStr,
} from "./types.js";

export { taint } from "./types.js";
export { SecurityKernelImpl } from "./kernel.js";
export { CONSTITUTIONAL_FLOOR, OperatorGate, violatesFloor } from "./operator.js";
export { actionCatalog, type ActionCatalogEntry, type ActionCategory } from "./catalog.js";

import { SecurityKernelImpl } from "./kernel.js";
import type { KernelConfig, SecurityKernel } from "./types.js";

export function createSecurityKernel(config: KernelConfig): SecurityKernel {
  return new SecurityKernelImpl(config);
}
