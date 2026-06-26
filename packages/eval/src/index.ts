/**
 * @lattice/eval — perception eval harness.
 *
 * Measures Lattice (compact IG + deltas) against the CHROME METHOD — a
 * screenshot agent and a raw-DOM agent — on identical scenarios, with
 * agent-browser as a semantic-engine parity reference. Reports perception
 * tokens and action accuracy, and renders the gate verdict.
 */

export { SCENARIOS } from "./scenarios.js";
export type { ResolvedScenario } from "./scenarios.js";
export { runScenario } from "./runners.js";
export type { ScenarioResult, SystemResult } from "./runners.js";
export { runEval, formatReport } from "./report.js";
export type { EvalReport, GateVerdict } from "./report.js";
export { estimateTokens } from "./tokens.js";
export { loadFrame, refByLabel } from "./fixtures.js";
export type { EvalFrame, Frame } from "./fixtures.js";
export { SCREENSHOT_TOKENS, SCREENSHOT_VIEWPORT } from "./frame.js";
export {
  render,
  renderAx,
  renderHtml,
  synthFrame,
  actionableNames,
  taskTrackerFlow,
} from "./synth.js";
export type { SynthNode, AppState, SynthStep } from "./synth.js";
export {
  ATTACKS,
  runGovernanceEval,
  formatGovernanceReport,
  wiredCountFor,
  DEPLOYMENT_ZERO_CONFIG,
  DEPLOYMENT_CONFIGURED,
  DEPLOYMENT_DESKTOP,
} from "./governance.js";
export type { DeploymentConfig } from "./governance.js";
export type { Attack, AttackClass, GovernanceResult } from "./governance.js";
export { runRecoveryEval, formatRecoveryReport } from "./recovery-eval.js";
export type { RecoveryEvalResult, RecoveryRowResult } from "./recovery-eval.js";
export { runCacheEval, formatCacheReport } from "./cache-eval.js";
export type { CacheEvalResult } from "./cache-eval.js";
export { runRecipeEval, formatRecipeReport } from "./recipe-eval.js";
export type { RecipeEvalResult } from "./recipe-eval.js";
