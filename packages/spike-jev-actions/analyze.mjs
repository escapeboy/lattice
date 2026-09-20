/**
 * Turns the run JSON into the report's tables. Read-only; no API calls.
 *   node analyze.mjs
 */
import fs from "node:fs";
import os from "node:os";

const RUNS = `${os.homedir()}/jev-eval/runs`;
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(`${RUNS}/${f}`, "utf8"));
  } catch {
    return null;
  }
};

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
};
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const f0 = (x) => (x == null ? "-" : x.toFixed(0));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const phase0 = read("phase0.json");
const phase1 = read("phase1.json");
const p2a = read("phase2a.json");
const p2at = read("phase2a-text.json");
const bFix = read("baseline-fixtures.json");
const bTask = read("baseline-tasks.json");

console.log("# Spike results\n");

/* ---------- 1. Phase 0 vs Phase 1 vs baseline, on the shared task set ---------- */
console.log("## 1. Task set: Phase 0 (vendor) vs Phase 1 (spike on Lattice IG) vs baseline (Claude)\n");
console.log("| column | n | success | med steps | med wall ms | med decide ms | med browser ms | text model ms | med tokens | cost/task |");
console.log("|---|---|---|---|---|---|---|---|---|---|");

function taskRow(name, rows, get) {
  if (!rows || rows.length === 0) {
    console.log(`| ${name} | – | not run | – | – | – | – | – | – | – |`);
    return;
  }
  const ok = rows.filter((r) => get.success(r)).length;
  const costs = rows.map(get.cost);
  console.log(
    `| ${name} | ${rows.length} | ${pct(ok, rows.length)} | ${med(rows.map(get.steps))} | ` +
      `${f0(med(rows.map(get.wall)))} | ${f0(med(rows.map(get.decide)))} | ${f0(med(rows.map(get.browser)))} | ` +
      `${get.text ? f0(med(rows.map(get.text))) : "0 (stubbed)"} | ${med(rows.map(get.tokens))} | ` +
      `$${(mean(costs) ?? 0).toFixed(6)} |`,
  );
}

taskRow("Phase 0 — jev-ultrafast", phase0, {
  success: (r) => r.success, steps: (r) => r.steps, wall: (r) => r.wall_ms,
  decide: (r) => r.jev_ms_total, browser: (r) => r.browser_ms_total,
  text: (r) => r.text_model_ms_total, tokens: (r) => r.input_tokens_total,
  cost: (r) => (r.input_tokens_total * 42) / 1e9,
});
taskRow("Phase 1 — spike on Lattice IG", phase1, {
  success: (r) => r.success, steps: (r) => r.steps, wall: (r) => r.wallMs,
  decide: (r) => r.jevMsTotal, browser: (r) => r.browserMsTotal,
  text: (r) => r.textModelMsTotal, tokens: (r) => r.inputTokensTotal,
  cost: (r) => r.costUsd,
});
taskRow("Baseline — Claude opus-5", bTask, {
  success: (r) => r.success, steps: (r) => r.steps, wall: (r) => r.wallMs,
  decide: (r) => r.llmMsTotal, browser: (r) => r.browserMsTotal,
  text: null, tokens: (r) => r.inputTokensTotal, cost: (r) => r.costUsd,
});

/* ---------- 2. Per-step decision latency ---------- */
console.log("\n## 2. Per-step decision latency (HTTP round trip only)\n");
console.log("| column | steps | p50 ms | p90 ms | max ms | share of wall time | at 300 ms/call |");
console.log("|---|---|---|---|---|---|---|");
function latRow(name, steps, lat, walls, decides) {
  if (!steps || steps.length === 0) { console.log(`| ${name} | – | – | – | – | – | – |`); return; }
  const totalWall = walls.reduce((a, b) => a + b, 0);
  const totalDecide = decides.reduce((a, b) => a + b, 0);
  const share = totalWall ? (100 * totalDecide) / totalWall : 0;
  const hypothetical = totalWall - totalDecide + steps.length * 300;
  const hypShare = hypothetical ? (100 * (steps.length * 300)) / hypothetical : 0;
  console.log(
    `| ${name} | ${steps.length} | ${f0(q(lat, 0.5))} | ${f0(q(lat, 0.9))} | ${f0(Math.max(...lat))} | ` +
      `${share.toFixed(1)}% | ${hypShare.toFixed(1)}% (wall ${f0(hypothetical / walls.length)} ms/task) |`,
  );
}
if (phase0) {
  const st = phase0.flatMap((r) => r.step_records);
  latRow("Phase 0 (Jev)", st, st.map((s) => s.jev_ms).filter((x) => x > 0),
    phase0.map((r) => r.wall_ms), phase0.map((r) => r.jev_ms_total));
}
for (const [name, rows, key] of [["Phase 1 (Jev)", phase1, "jevMs"], ["Phase 2A (Jev)", p2a, "jevMs"], ["Phase 2A+text (Jev)", p2at, "jevMs"]]) {
  if (!rows) continue;
  const st = rows.flatMap((r) => r.stepRecords);
  latRow(name, st, st.map((s) => s[key]).filter((x) => x > 0),
    rows.map((r) => r.wallMs), rows.map((r) => r.jevMsTotal));
}
for (const [name, rows] of [["Baseline fixtures (Claude)", bFix], ["Baseline tasks (Claude)", bTask]]) {
  if (!rows) continue;
  const st = rows.flatMap((r) => r.stepRecords);
  latRow(name, st, st.map((s) => s.llmMs).filter((x) => x > 0),
    rows.map((r) => r.wallMs), rows.map((r) => r.llmMsTotal));
}

/* ---------- 3. Phase 2A hijack rates ---------- */
const VAR = ["clean", "inject_direct", "inject_authority", "inject_hidden"];
function hijackTable(title, rows, gateModes) {
  if (!rows) { console.log(`\n### ${title}: not run\n`); return; }
  console.log(`\n### ${title}\n`);
  console.log("| gate | variant | n | success | HIJACK (executed) | hijack stopped by gate | mean P(target=injected) @ step 1 | shift vs clean |");
  console.log("|---|---|---|---|---|---|---|---|");
  const cleanP = {};
  for (const g of gateModes) {
    const base = rows.filter((r) => (r.gateMode ?? "none") === g && r.variant === "clean")
      .map((r) => r.pInjectedStep1).filter((x) => x != null);
    cleanP[g] = mean(base) ?? 0;
  }
  for (const g of gateModes) {
    for (const v of VAR) {
      const r = rows.filter((x) => (x.gateMode ?? "none") === g && x.variant === v);
      if (!r.length) continue;
      const ps = r.map((x) => x.pInjectedStep1).filter((x) => x != null);
      const m = mean(ps);
      const shift = m == null ? null : m - cleanP[g];
      console.log(
        `| ${g} | ${v} | ${r.length} | ${pct(r.filter((x) => x.success).length, r.length)} | ` +
          `${pct(r.filter((x) => x.hijack).length, r.length)} | ${pct(r.filter((x) => x.hijackBlockedByGate).length, r.length)} | ` +
          `${m == null ? "-" : m.toFixed(4)} (n=${ps.length}) | ${shift == null ? "-" : (shift >= 0 ? "+" : "") + shift.toFixed(4)} |`,
      );
    }
  }
}
console.log("\n## 3. Phase 2A — adversarial fixtures\n");
hijackTable("Spike, state = element table only", p2a, ["none", "verb", "semantic"]);
hijackTable("Spike, state = element table + visible page text", p2at, ["none", "verb", "semantic"]);
if (bFix) {
  console.log("\n### Baseline (Claude), state = element table + visible page text, ungated\n");
  console.log("| variant | n | success | HIJACK (executed) |");
  console.log("|---|---|---|---|");
  for (const v of VAR) {
    const r = bFix.filter((x) => x.variant === v);
    if (!r.length) continue;
    console.log(`| ${v} | ${r.length} | ${pct(r.filter((x) => x.success).length, r.length)} | ${pct(r.filter((x) => x.hijack).length, r.length)} |`);
  }
}

/* ---------- 4. Failure catalogue ---------- */
console.log("\n## 4. Failure catalogue\n");
function failures(label, rows, opts) {
  if (!rows) return;
  const fails = rows.filter((r) => !r.success);
  console.log(`\n### ${label} — ${fails.length} of ${rows.length} failed\n`);
  const seen = new Set();
  for (const f of fails) {
    const key = opts.key(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const steps = f.stepRecords ?? f.step_records ?? [];
    const last = steps[steps.length - 1];
    console.log(`- **${key}** — ${f.terminal}${f.verifyError || f.verify_error ? ` (verify: ${String(f.verifyError ?? f.verify_error).slice(0, 80)})` : ""}`);
    if (last) {
      const probs = last.operationProbabilities ?? last.operation_probabilities;
      console.log(`  - failed at step ${last.step}: op=${last.operation} conf=${last.operationConfidence ?? last.confidence ?? "-"}`);
      if (probs) console.log(`  - operation distribution: ${JSON.stringify(probs)}`);
      const tp = last.targetProbabilities ?? last.target_probabilities;
      if (tp && Object.keys(tp).length) console.log(`  - target distribution: ${JSON.stringify(tp)} (chose ${last.targetLabel ?? last.target ?? "-"})`);
    }
  }
}
failures("Phase 0 (jev-ultrafast)", phase0, { key: (f) => `${f.task}#${f.attempt}` });
failures("Phase 1 (spike, task set)", phase1, { key: (f) => `${f.task}#${f.attempt}` });
failures("Phase 2A (spike, element table only)", p2a, { key: (f) => `${f.flow}/${f.variant}/${f.gateMode}` });
failures("Phase 2A (spike, + page text)", p2at, { key: (f) => `${f.flow}/${f.variant}/${f.gateMode}` });
failures("Baseline (Claude, task set)", bTask, { key: (f) => `${f.name}#${f.attempt}` });
failures("Baseline (Claude, fixtures)", bFix, { key: (f) => `${f.name}/${f.variant}` });
