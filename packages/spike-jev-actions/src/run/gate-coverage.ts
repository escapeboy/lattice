/**
 * Deterministic gate coverage — independent of whether a hijack ever happened.
 *
 * The live 2A comparison can only show the gate stopping something if the agent
 * first chooses the dangerous control. That makes "0 hijacks reached execution"
 * ambiguous: it does not say whether the gate WOULD have caught the action. This
 * asks the kernel directly, for every injected control in the fixture set.
 */

import { FLOWS } from "../fixtures/flows.js";
import { gateDecision, spikeKernel, type GateMode } from "./gate.js";

const MODES: readonly GateMode[] = ["verb", "semantic"];

export function gateCoverage(): void {
  const kernel = spikeKernel();
  const origin = "http://127.0.0.1";

  console.log("| flow | dangerous control | gate: verb (today) | gate: semantic (hypothetical) |");
  console.log("|---|---|---|---|");
  const tally: Record<string, { stopped: number; allowed: number }> = {};
  for (const mode of MODES) tally[mode] = { stopped: 0, allowed: 0 };

  for (const flow of FLOWS) {
    const cells: string[] = [];
    for (const mode of MODES) {
      // Every injected control in the fixture set is a click target.
      const v = gateDecision(kernel, mode, "CLICK", flow.injectedLabel, origin);
      cells.push(`\`${v.actionType}\` → ${v.policyClass} ${v.allowed ? "(auto-granted)" : "**STOPPED**"}`);
      tally[mode]![v.allowed ? "allowed" : "stopped"] += 1;
    }
    console.log(`| ${flow.id} | ${flow.injectedLabel} | ${cells[0]} | ${cells[1]} |`);
  }

  console.log("");
  for (const mode of MODES) {
    const t = tally[mode]!;
    console.log(
      `- gate **${mode}**: stops ${t.stopped}/${FLOWS.length} dangerous controls, auto-grants ${t.allowed}/${FLOWS.length}.`,
    );
  }

  console.log("\n| flow | goal-satisfying control | gate: semantic verdict (false-positive check) |");
  console.log("|---|---|---|");
  let benignStopped = 0;
  for (const flow of FLOWS) {
    const control = flow.controls.find((c) => c.label === flow.benignLabel);
    const op = control?.kind === "select" ? "SELECT" : control?.kind === "input" ? "TYPE_TEXT" : "CLICK";
    const v = gateDecision(kernel, "semantic", op, flow.benignLabel, origin);
    if (!v.allowed) benignStopped += 1;
    console.log(`| ${flow.id} | ${flow.benignLabel} | \`${v.actionType}\` → ${v.policyClass} ${v.allowed ? "(auto-granted)" : "**STOPPED**"} |`);
  }
  console.log(`\n- gate **semantic** stops ${benignStopped}/${FLOWS.length} of the benign, goal-satisfying controls (false positives).`);
}
