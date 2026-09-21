/**
 * Held-out validation of the effect gate.
 *
 * Runs the real kernel over `data/heldout-cases.jsonl` — 78 pending actions from
 * 25 origins that were NOT among the 19 the gate was tuned on — and scores it
 * against `data/heldout-labels.jsonl`, which was committed first so the order is
 * auditable.
 *
 * Nothing here is allowed to read the label before classifying. The evidence the
 * gate sees is exactly what the capture probe recorded.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecurityKernel, type EffectEvidence, type PolicyClass } from "@lattice/kernel";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "../../data");
const CLASSES: readonly PolicyClass[] = ["read", "benign", "consequential", "prohibited"];
const SEVERITY: Record<PolicyClass, number> = { read: 0, benign: 1, consequential: 2, prohibited: 3 };

interface Case {
  id: string;
  source: string;
  origin: string;
  lang: string;
  sector: string;
  action: { verb: string; actionType: string };
  target: { role: string; label: string; href?: string };
  evidence: EffectEvidence;
}

interface Label {
  id: string;
  label: PolicyClass;
  why: string;
}

function readJsonl<T>(name: string): T[] {
  return readFileSync(join(DATA, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

const kernel = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });

function matrix(pairs: Array<{ gold: PolicyClass; got: PolicyClass }>): string {
  const counts = new Map<string, number>();
  for (const p of pairs) counts.set(`${p.gold}|${p.got}`, (counts.get(`${p.gold}|${p.got}`) ?? 0) + 1);
  const lines = [
    `| labelled \\ predicted | ${CLASSES.join(" | ")} | total |`,
    `|---|${CLASSES.map(() => "---:").join("|")}|---:|`,
  ];
  for (const g of CLASSES) {
    const row = CLASSES.map((p) => counts.get(`${g}|${p}`) ?? 0);
    const total = row.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    lines.push(
      `| **${g}** | ${row.map((n, i) => (CLASSES[i] === g ? `**${n}**` : String(n))).join(" | ")} | ${total} |`,
    );
  }
  const agree = pairs.filter((p) => p.gold === p.got).length;
  lines.push("", `Exact agreement: ${agree}/${pairs.length} (${((agree / pairs.length) * 100).toFixed(1)}%).`);
  return lines.join("\n");
}

export function runHeldoutEval(): void {
  const cases = readJsonl<Case>("heldout-cases.jsonl");
  const labels = new Map(readJsonl<Label>("heldout-labels.jsonl").map((l) => [l.id, l]));

  const rows = cases.map((c) => {
    const verdict = kernel.classifyDetailed({
      actionType: c.action.actionType,
      origin: c.origin,
      sessionId: "heldout-eval",
      payload: c.id,
      effect: c.evidence,
    });
    const label = labels.get(c.id);
    if (label === undefined) throw new Error(`no label for ${c.id}`);
    return { c, label, got: verdict.policyClass, reasons: verdict.reasons };
  });

  console.log("## Confusion matrix — 78 held-out cases, 25 unseen origins\n");
  console.log(matrix(rows.map((r) => ({ gold: r.label.label, got: r.got }))));

  const under = rows.filter((r) => SEVERITY[r.got] < SEVERITY[r.label.label]);
  const over = rows.filter((r) => SEVERITY[r.got] > SEVERITY[r.label.label]);

  console.log(`\n## Misses — gate classified BELOW the label (${under.length})\n`);
  for (const r of under) {
    console.log(`- \`${r.c.id}\` **${r.label.label} → ${r.got}** · ${r.c.target.role} "${r.c.target.label.trim()}"`);
    console.log(`  - label rationale: ${r.label.why}`);
    console.log(`  - gate reasons: ${r.reasons.length ? r.reasons.join("; ") : "(none — fell through to the default)"}`);
    console.log(`  - ${r.c.source}`);
  }

  console.log(`\n## Over-fires — gate classified ABOVE the label (${over.length})\n`);
  for (const r of over) {
    console.log(`- \`${r.c.id}\` **${r.label.label} → ${r.got}** · ${r.c.target.role} "${r.c.target.label.trim()}"`);
    console.log(`  - signal that fired: ${r.reasons.length ? r.reasons.join("; ") : "(none)"}`);
    console.log(`  - ${r.c.source}`);
  }

  const byLang = (lang: string) => {
    const sub = rows.filter((r) => r.c.lang === lang);
    const ok = sub.filter((r) => r.got === r.label.label).length;
    return `${ok}/${sub.length}`;
  };
  console.log(`\n## By language\n`);
  console.log(`- bg: ${byLang("bg")} exact`);
  console.log(`- en: ${byLang("en")} exact`);

  const sectors = [...new Set(rows.map((r) => r.c.sector))].sort();
  console.log(`\n## By sector\n`);
  for (const s of sectors) {
    const sub = rows.filter((r) => r.c.sector === s);
    const ok = sub.filter((r) => r.got === r.label.label).length;
    console.log(`- ${s}: ${ok}/${sub.length} exact`);
  }
}
