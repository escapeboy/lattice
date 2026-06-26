/**
 * @lattice/eval — S5.5 eval harness (improvements-backlog P0 gate).
 *
 * Measures perception tokens + action accuracy of the Lattice build-on stack
 * against bare agent-browser on identical scenarios, and renders the gate
 * verdict. The gate accepts "not better" as a valid result.
 */

export { SCENARIOS } from "./scenarios.js";
export type { Scenario, EvalStep } from "./scenarios.js";
export { runScenario } from "./runners.js";
export type { ScenarioResult, SystemResult } from "./runners.js";
export { runEval, formatReport } from "./report.js";
export type { EvalReport, GateVerdict } from "./report.js";
export { estimateTokens } from "./tokens.js";
export { loadFrame, refByLabel } from "./fixtures.js";
export type { Frame } from "./fixtures.js";
