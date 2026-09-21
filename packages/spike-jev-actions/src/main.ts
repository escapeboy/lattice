/**
 * Spike entry point.
 *
 *   op run --env-file=.env.op -- npx tsx src/main.ts <command>
 *
 * Commands: smoke | phase2a | phase1 | connect
 */

import { runPhase2A } from "./run/phase2a.js";
import { startFixtureServer } from "./fixtures/server.js";
import { startHarness } from "./run/harness.js";
import { decideOnce } from "./decide.js";
import { FLOWS } from "./fixtures/flows.js";
import { connectStats } from "./run/connect.js";
import { runPhase1 } from "./run/phase1.js";
import { runRound2 } from "./run/round2.js";
import { round2Coverage } from "./run/round2-coverage.js";
import { runBackstopField } from "./run/backstop-field.js";
import { captureHeldout } from "./dataset/heldout.js";
import { runHeldoutEval } from "./run/heldout-eval.js";
import { capture } from "./dataset/capture.js";
import { buildDataset } from "./dataset/build.js";
import { runBaselineFixtures, runBaselineTasks } from "./run/phase-baseline.js";
import { gateCoverage } from "./run/gate-coverage.js";

const OUT = `${process.env["HOME"]}/jev-eval/runs`;
const DATA = `${process.env["HOME"]}/jev-eval/datasets/lattice`;

async function smoke(): Promise<void> {
  const server = await startFixtureServer();
  const harness = await startHarness(true);
  try {
    const flow = FLOWS[2]!; // delete-account: the sharpest benign/dangerous pair
    for (const variant of ["clean", "inject_direct", "inject_hidden"] as const) {
      const { run } = await harness.open(server.urlFor(flow.id, variant));
      const { ig, table, browserMs } = await run.perceive();
      const decision = await decideOnce({ ig, table, goal: flow.goal, recentActions: [] });
      const labels = table.elements.map((e) => `${e.index}:${e.role}:${e.label}`);
      console.log(`\n--- ${flow.id}/${variant} ---`);
      console.log(`IG nodes=${ig.nodes.size} table=${table.elements.length} browserMs=${browserMs.toFixed(0)}`);
      console.log(`elements: ${labels.join(" | ")}`);
      console.log(`outcome: ${JSON.stringify(decision.outcome)}`);
      console.log(`op conf=${decision.operationAnswer?.confidence} probs=${JSON.stringify(decision.operationAnswer?.probabilities)}`);
      console.log(`targets: ${JSON.stringify(Object.fromEntries(Object.entries(decision.targetAnswers).map(([k, v]) => [k, { choice: v.choice, confidence: v.confidence, probabilities: v.probabilities }])))}`);
      console.log(`jevMs=${decision.jevLatencyMs.toFixed(0)} tokens=${decision.inputTokens}`);
      await run.close();
    }
  } finally {
    await harness.shutdown();
    await server.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "smoke";
  if (cmd === "smoke") return smoke();
  if (cmd === "connect") return connectStats();
  if (cmd === "heldout-eval") return runHeldoutEval();
  if (cmd === "heldout-capture-deep") {
    const cases = await captureHeldout(`${DATA}/heldout-cases-deep.jsonl`, true);
    console.log(`\nheldout-capture-deep: ${cases.length} cases -> ${DATA}/heldout-cases-deep.jsonl`);
    return;
  }
  if (cmd === "heldout-capture") {
    const cases = await captureHeldout(`${DATA}/heldout-cases.jsonl`);
    console.log(`\nheldout-capture: ${cases.length} cases -> ${DATA}/heldout-cases.jsonl`);
    return;
  }
  if (cmd === "backstop-field") {
    const records = await runBackstopField(`${OUT}/backstop-field.json`);
    console.log(`\nbackstop-field: ${records.length} flows -> ${OUT}/backstop-field.json`);
    return;
  }
  if (cmd === "round2-coverage") return round2Coverage();
  if (cmd === "round2") {
    const records = await runRound2(`${OUT}/round2.json`);
    console.log(`\nround2: ${records.length} runs -> ${OUT}/round2.json`);
    return;
  }
  if (cmd === "phase2a") {
    const records = await runPhase2A(`${OUT}/phase2a.json`);
    console.log(`\nphase2a: ${records.length} runs -> ${OUT}/phase2a.json`);
    return;
  }
  if (cmd === "phase2a-text") {
    const records = await runPhase2A(`${OUT}/phase2a-text.json`, true);
    console.log(`\nphase2a-text: ${records.length} runs -> ${OUT}/phase2a-text.json`);
    return;
  }
  if (cmd === "phase1") {
    const records = await runPhase1(`${OUT}/phase1.json`);
    console.log(`\nphase1: ${records.length} runs -> ${OUT}/phase1.json`);
    return;
  }
  if (cmd === "capture") {
    const snaps = await capture(`${DATA}/snapshots.json`);
    console.log(`captured ${snaps.length} snapshots across ${new Set(snaps.map((s) => s.origin)).size} origins`);
    return;
  }
  if (cmd === "dataset") {
    const stats = buildDataset(`${DATA}/snapshots.json`, `${DATA}/adversarial.jsonl`);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  if (cmd === "baseline-fixtures") {
    const r = await runBaselineFixtures(`${OUT}/baseline-fixtures.json`, true);
    console.log(`\nbaseline-fixtures: ${r.length} runs -> ${OUT}/baseline-fixtures.json`);
    return;
  }
  if (cmd === "baseline-tasks") {
    const r = await runBaselineTasks(`${OUT}/baseline-tasks.json`);
    console.log(`\nbaseline-tasks: ${r.length} runs -> ${OUT}/baseline-tasks.json`);
    return;
  }
  if (cmd === "gate-coverage") {
    gateCoverage();
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
