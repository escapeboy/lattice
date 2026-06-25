/**
 * @lattice/kernel — Security kernel.
 */

export type {
  AuditEvent,
  CapabilityRequest,
  EgressRequest,
  GrantDecision,
  KernelConfig,
  PolicyClass,
  PolicyRule,
  SecurityKernel,
  TaintedStr,
} from "./types.js";

export { taint } from "./types.js";
export { SecurityKernelImpl } from "./kernel.js";

import { SecurityKernelImpl } from "./kernel.js";
import type { KernelConfig, SecurityKernel } from "./types.js";

export function createSecurityKernel(config: KernelConfig): SecurityKernel {
  return new SecurityKernelImpl(config);
}
