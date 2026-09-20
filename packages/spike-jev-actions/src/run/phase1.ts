/**
 * Phase 1 — the spike on Lattice's own Interaction Graph, over the shared task
 * set. Same per-step timing breakdown as Phase 0: Jev round trip, text model,
 * browser.
 *
 * Success is decided by the task's own verifier read from the final page, never
 * by the model's DONE.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FLIGHTS_TASK, TASKS, type Task } from "./tasks.js";
import { startHarness, type Run } from "./harness.js";
import { decideOnce, isRetryableBlock } from "../decide.js";
import type { RecentAction } from "../questions.js";
import { markPage, effectOf, NO_EFFECT } from "./page-mark.js";
import { costUsd } from "../jev-client.js";
import type { StepRecord } from "./phase2a.js";

const MAX_STEPS = 10;
const FLIGHTS_REPEATS = 5;

export interface TaskRecord {
  readonly task: string;
  readonly attempt: number;
  readonly goal: string;
  readonly shape: string;
  readonly success: boolean;
  readonly verifyError: string | null;
  readonly steps: number;
  readonly wallMs: number;
  readonly navigateMs: number;
  readonly jevMsTotal: number;
  readonly browserMsTotal: number;
  readonly execMsTotal: number;
  readonly textModelMsTotal: number;
  readonly inputTokensTotal: number;
  readonly costUsd: number;
  readonly terminal: string;
  readonly stepRecords: readonly StepRecord[];
}

async function runTask(run: Run, task: Task, attempt: number, navigateMs: number): Promise<TaskRecord> {
  const steps: StepRecord[] = [];
  const recentActions: RecentAction[] = [];
  const startedWall = performance.now();
  let terminal = "max_steps";
  let retriedThisStep = false;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const { ig, table, browserMs } = await run.perceive();
    // Phase 0 puts the page's visible text in state; so must this, or the two
    // columns are not measuring the same thing.
    const pageText = await run.pageText();
    const decision = await decideOnce({ ig, table, goal: task.goal, recentActions, pageText });
    const opAnswer = decision.operationAnswer;
    const base = {
      step,
      operationConfidence: opAnswer?.confidence ?? null,
      operationProbabilities: opAnswer ? { ...opAnswer.probabilities } : null,
      jevMs: decision.jevLatencyMs,
      browserMs,
      inputTokens: decision.inputTokens,
      pInjected: null,
      gate: null,
      ...(decision.operationBranch !== undefined ? { operationBranch: decision.operationBranch } : {}),
      ...(decision.targetBranch !== undefined ? { targetBranch: decision.targetBranch } : {}),
      ...(decision.excludedByLoop.length > 0 ? { excludedByLoop: decision.excludedByLoop } : {}),
    };

    if (decision.outcome.kind === "blocked") {
      const reason = decision.outcome.reason;
      if (isRetryableBlock(reason) && !retriedThisStep) {
        retriedThisStep = true;
        steps.push({ ...base, operation: "BLOCKED", targetIndex: null, targetLabel: null, targetConfidence: null, targetProbabilities: null, execMs: 0, textModelMs: 0, note: `${reason} — re-perceiving once` });
        continue;
      }
      steps.push({ ...base, operation: "BLOCKED", targetIndex: null, targetLabel: null, targetConfidence: null, targetProbabilities: null, execMs: 0, textModelMs: 0, note: reason });
      terminal = `blocked:${reason}`;
      break;
    }
    retriedThisStep = false;

    if (decision.outcome.kind === "control") {
      const op = decision.outcome.operation;
      const startedExec = performance.now();
      const beforeControl = await markPage(run.ctx.cdp());
      if (op === "SCROLL_DOWN" || op === "SCROLL_UP") {
        await run.ctx.cdp().send("Runtime.evaluate", {
          expression: `scrollBy(0, ${op === "SCROLL_DOWN" ? "innerHeight*0.8" : "-innerHeight*0.8"})`,
        }).catch(() => undefined);
      } else if (op === "WAIT") {
        await new Promise((r) => setTimeout(r, 400));
      }
      const controlEffect =
        op === "DONE" ? NO_EFFECT : effectOf(beforeControl, await markPage(run.ctx.cdp()));
      steps.push({ ...base, operation: op, targetIndex: null, targetLabel: null, targetConfidence: null, targetProbabilities: null, execMs: performance.now() - startedExec, textModelMs: 0, note: null });
      recentActions.push({ operation: op, ...controlEffect });
      if (op === "DONE") { terminal = "done"; break; }
      continue;
    }

    const { operation, targetIndex } = decision.outcome;
    const target = table.byIndex.get(targetIndex);
    const answer = decision.targetAnswers[
      operation === "CLICK" ? "click_target" : operation === "TYPE_TEXT" ? "type_text_target" : "select_target"
    ];

    let note: string | null = null;
    const beforeMark = await markPage(run.ctx.cdp());
    const startedExec = performance.now();
    try {
      if (!target) throw new Error("target index not in table");
      if (operation === "CLICK") {
        await run.action.execute({ type: "act", target: { nodeId: target.nodeId } });
      } else if (operation === "TYPE_TEXT") {
        if (!task.typedValue) throw new Error("no stubbed text value for this task");
        await run.action.execute({ type: "fill", target: { nodeId: target.nodeId }, value: task.typedValue });
      } else {
        await run.action.execute({ type: "select", target: { nodeId: target.nodeId }, value: task.typedValue ?? "" });
      }
    } catch (err) {
      note = `exec_error: ${(err as Error).message}`.slice(0, 200);
    }

    const observedEffect = effectOf(beforeMark, await markPage(run.ctx.cdp()));
    steps.push({
      ...base,
      operation,
      targetIndex,
      targetLabel: target?.label ?? null,
      targetConfidence: answer?.confidence ?? null,
      targetProbabilities: answer ? { ...answer.probabilities } : null,
      execMs: performance.now() - startedExec,
      textModelMs: 0,
      observedEffect,
      note,
    });
    recentActions.push({
      operation,
      targetIndex,
      ...(target?.role !== undefined ? { targetRole: target.role } : {}),
      ...(target?.label !== undefined && target.label !== null ? { targetLabel: target.label } : {}),
      ...observedEffect,
    });
  }

  // Independent verification of the FINAL page — not the model's claim.
  let success = false;
  let verifyError: string | null = null;
  try {
    const res = await run.ctx.cdp().send<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression: `(() => { try { return !!(${task.verify}); } catch (e) { return 'ERR:' + e.message; } })()`,
      returnByValue: true,
    });
    const v = res.result.value;
    if (typeof v === "string") verifyError = v;
    else success = v === true;
  } catch (err) {
    verifyError = (err as Error).message;
  }

  const wallMs = performance.now() - startedWall;
  const sum = (f: (s: StepRecord) => number): number => steps.reduce((a, s) => a + f(s), 0);
  const inputTokensTotal = sum((s) => s.inputTokens);

  return {
    task: task.id,
    attempt,
    goal: task.goal,
    shape: task.shape,
    success,
    verifyError,
    steps: steps.length,
    wallMs,
    navigateMs,
    jevMsTotal: sum((s) => s.jevMs),
    browserMsTotal: sum((s) => s.browserMs),
    execMsTotal: sum((s) => s.execMs),
    textModelMsTotal: sum((s) => s.textModelMs),
    inputTokensTotal,
    costUsd: costUsd(inputTokensTotal),
    terminal,
    stepRecords: steps,
  };
}

export async function runPhase1(outPath: string): Promise<TaskRecord[]> {
  const harness = await startHarness(true);
  const records: TaskRecord[] = [];
  const plan: Array<{ task: Task; attempt: number }> = [];
  for (let i = 1; i <= FLIGHTS_REPEATS; i++) plan.push({ task: FLIGHTS_TASK, attempt: i });
  for (const t of TASKS) plan.push({ task: t, attempt: 1 });

  try {
    for (const { task, attempt } of plan) {
      let rec: TaskRecord;
      const { run, navigateMs } = await harness.open(task.url, { dismissInterstitial: true });
      try {
        rec = await runTask(run, task, attempt, navigateMs);
      } catch (err) {
        rec = {
          task: task.id, attempt, goal: task.goal, shape: task.shape, success: false,
          verifyError: `run_error: ${(err as Error).message}`.slice(0, 300),
          steps: 0, wallMs: 0, navigateMs, jevMsTotal: 0, browserMsTotal: 0, execMsTotal: 0,
          textModelMsTotal: 0, inputTokensTotal: 0, costUsd: 0, terminal: "run_error", stepRecords: [],
        };
      } finally {
        await run.close().catch(() => undefined);
      }
      records.push(rec);
      process.stderr.write(
        `${rec.task}#${rec.attempt}: success=${rec.success} steps=${rec.steps} ` +
          `wall=${rec.wallMs.toFixed(0)}ms jev=${rec.jevMsTotal.toFixed(0)}ms ${rec.terminal}` +
          `${rec.verifyError ? ` verify=${rec.verifyError}` : ""}\n`,
      );
      writeJson(outPath, records);
    }
  } finally {
    await harness.shutdown();
  }
  writeJson(outPath, records);
  return records;
}

function writeJson(path: string, records: TaskRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 1));
}
