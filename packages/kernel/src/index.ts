/**
 * @lattice/kernel — Security kernel.
 */

export type {
  ActionDetail,
  AuditEvent,
  CapabilityRequest,
  EgressRequest,
  GrantFieldPreview,
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
export type { EffectEvidence, EffectVerdict } from "./effect.js";
export { classifyEffect } from "./effect.js";
export {
  EFFECT_LEXICON,
  EFFECT_LEXICON_VERSION,
  matchTerm,
  hasMonetaryAmount,
  normalizeForMatch,
} from "./effect-lexicon.js";
export type { EffectLexicon, TermSet } from "./effect-lexicon.js";
export { SecurityKernelImpl } from "./kernel.js";
export { CONSTITUTIONAL_FLOOR, OperatorGate, violatesFloor } from "./operator.js";
export { actionCatalog, type ActionCatalogEntry, type ActionCategory } from "./catalog.js";

import { SecurityKernelImpl } from "./kernel.js";
import type { KernelConfig, SecurityKernel } from "./types.js";

export function createSecurityKernel(config: KernelConfig): SecurityKernel {
  return new SecurityKernelImpl(config);
}
