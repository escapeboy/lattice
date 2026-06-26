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
