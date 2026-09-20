/**
 * Field measurement for the effect backstop.
 *
 * The number that decides whether this can be left on is FALSE ESCALATIONS PER
 * TASK — how often a human is interrupted for a request the agent did not
 * cause. Everything else (true catches, latency) is secondary: a gate that
 * cries wolf gets switched off, and then it protects nothing.
 *
 * Ten real logged-out flows on live sites. No accounts, no checkout, no
 * payment: the flows stop at the point where a real commitment would begin,
 * which is also exactly where the gate should start refusing.
 *
 * Every paused request is recorded with its verdict so the escalations can be
 * judged one by one rather than asserted in aggregate.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { InteractionGraph } from "@lattice/perception";
import { EffectBackstop, pointerPointFor, resolveTarget, type PausedRequest } from "@lattice/action";

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
/** Time the page is watched before the first action, to build the baseline. */
const SETTLE_MS = 3000;
/** Time an armed window stays open after a step. */
const WINDOW_MS = 1500;

/**
 * Targets are matched by ROLE + ACCESSIBLE NAME through the Interaction Graph,
 * the same way Lattice addresses a control — not by CSS. A first pass used CSS
 * selectors and four of ten flows ran zero steps, which measures nothing.
 */
type Step =
  | { kind: "click"; role: string; label: RegExp; note: string }
  | { kind: "type"; role: string; label: RegExp; value: string; note: string }
  | { kind: "enter"; note: string }
  | { kind: "wait"; ms: number; note: string };

interface Flow {
  readonly id: string;
  readonly url: string;
  readonly kind: "search" | "filter" | "cart" | "newsletter" | "consent" | "nav";
  readonly lang: "en" | "bg";
  readonly steps: readonly Step[];
}

/**
 * Live sites: a control that cannot be found degrades to a skipped step,
 * never a crashed run. Skipped steps are reported, because a flow that ran no
 * steps measures nothing.
 */
const FLOWS: readonly Flow[] = [
  {
    id: "mdn-search",
    url: "https://developer.mozilla.org/en-US/",
    kind: "search",
    lang: "en",
    steps: [
      { kind: "click", role: "input", label: /search/i, note: "focus search" },
      { kind: "type", role: "input", label: /search/i, value: "fetch", note: "type query (typeahead XHR per keystroke)" },
      { kind: "wait", ms: 1000, note: "settle" },
    ],
  },
  {
    id: "ddg-search",
    url: "https://duckduckgo.com/",
    kind: "search",
    lang: "en",
    steps: [
      { kind: "click", role: "input", label: /search|търси/i, note: "focus search" },
      { kind: "type", role: "input", label: /search|търси/i, value: "interaction design", note: "type query" },
      { kind: "enter", note: "submit search (SPA transition)" },
    ],
  },
  {
    id: "nodejs-nav",
    url: "https://nodejs.org/en",
    kind: "nav",
    lang: "en",
    steps: [
      { kind: "click", role: "link", label: /^Docs$|Learn/, note: "navigate" },
      { kind: "wait", ms: 900, note: "settle" },
    ],
  },
  {
    id: "webscraper-filter",
    url: "https://webscraper.io/test-sites/e-commerce/allinone",
    kind: "filter",
    lang: "en",
    steps: [
      { kind: "click", role: "link", label: /^Home$/, note: "category nav" },
      { kind: "wait", ms: 800, note: "settle" },
      { kind: "click", role: "link", label: /Lenovo|Dell|Asus/, note: "open a product (server-rendered filter/nav)" },
    ],
  },
  {
    id: "wikivoyage-search",
    url: "https://en.wikivoyage.org/wiki/Main_Page",
    kind: "search",
    lang: "en",
    steps: [
      { kind: "click", role: "input", label: /search|travel/i, note: "focus search" },
      { kind: "type", role: "input", label: /search|travel/i, value: "sofia", note: "type query (suggest XHR)" },
      { kind: "wait", ms: 1000, note: "settle" },
    ],
  },
  {
    id: "mediawiki-search",
    url: "https://www.mediawiki.org/wiki/MediaWiki",
    kind: "search",
    lang: "en",
    steps: [
      { kind: "click", role: "input", label: /search/i, note: "focus search" },
      { kind: "type", role: "input", label: /search/i, value: "api", note: "type query (suggest XHR)" },
      { kind: "wait", ms: 1000, note: "settle" },
    ],
  },
  {
    id: "hn-nav",
    url: "https://news.ycombinator.com/",
    kind: "nav",
    lang: "en",
    steps: [
      { kind: "click", role: "link", label: /^new$/, note: "navigate" },
      { kind: "wait", ms: 800, note: "settle" },
    ],
  },
  {
    id: "dnes-consent",
    url: "https://www.dnes.bg/",
    kind: "consent",
    lang: "bg",
    steps: [
      { kind: "click", role: "button", label: /ОК, продължи|Приеми|Съгласен|Разбрах/i, note: "accept the cookie dialog (writes consent state)" },
      { kind: "wait", ms: 1400, note: "settle" },
    ],
  },
  {
    id: "emag-favourite",
    url: "https://www.emag.bg/",
    kind: "cart",
    lang: "bg",
    steps: [
      { kind: "click", role: "button", label: /^Приеми всички$/, note: "accept consent" },
      { kind: "wait", ms: 900, note: "settle" },
      { kind: "click", role: "button", label: /Добави в Любими/, note: "add to favourites — a REAL logged-out state change" },
      { kind: "wait", ms: 1400, note: "settle" },
    ],
  },
  {
    id: "ozone-consent",
    url: "https://www.ozone.bg/",
    kind: "consent",
    lang: "bg",
    steps: [
      { kind: "click", role: "button", label: /^Запази$|Приеми|Съгласен/i, note: "save cookie preferences (writes consent state)" },
      { kind: "wait", ms: 1400, note: "settle" },
      { kind: "click", role: "link", label: /Лаптоп|Телевизор|Телефон/i, note: "category filter" },
      { kind: "wait", ms: 1200, note: "settle" },
    ],
  },
];

export interface DecisionRecord {
  readonly flow: string;
  readonly step: number;
  readonly stepNote: string;
  readonly held: boolean;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly reason: string;
}

export interface FlowRecord {
  readonly flow: string;
  readonly kind: string;
  readonly lang: string;
  readonly url: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly stepsRun: number;
  readonly stepsSkipped: number;
  /** Requests examined inside armed windows. */
  readonly examined: number;
  /** Requests held and escalated. */
  readonly escalated: number;
  /** Endpoint keys observed before the first action. */
  readonly baseline: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly decisions: readonly DecisionRecord[];
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * Resolve a role+label match to a live backendNodeId, preferring what is on
 * screen. Matches against the accessible name, the placeholder and the raw AX
 * name: a search box is labelled three different ways across these sites, and
 * matching only one of them silently skipped the step.
 */
async function findTarget(
  ctx: ContextHandle,
  role: string,
  label: RegExp,
): Promise<{ backendNodeId: number; label: string } | undefined> {
  let available: string[] = [];
  try {
    const ig = (await createPerceptionEngine(ctx.cdp()).snapshot("L1")) as InteractionGraph;
    const candidates = [...ig.nodes.values()].filter((n) => !n.state.hidden && !n.state.disabled);
    available = candidates
      .filter((n) => n.role === role)
      .slice(0, 14)
      .map((n) => `${n.role}:${JSON.stringify(n.label).slice(0, 30)}`);

    const names = (n: (typeof candidates)[number]): string[] =>
      [n.label, n.placeholder, n.axName].filter((x): x is string => typeof x === "string" && x.length > 0);

    const matches = candidates.filter((n) => n.role === role && names(n).some((x) => label.test(x)));
    matches.sort(
      (a, b) => Number(b.geometry?.inViewport ?? false) - Number(a.geometry?.inViewport ?? false),
    );
    for (const node of matches) {
      try {
        const resolved = await resolveTarget(ctx.cdp(), node.id);
        return { backendNodeId: resolved.backendDOMNodeId, label: node.label };
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  process.stderr.write(`    [skip] no ${role} matching ${label.source}; saw: ${available.join(" | ")}\n`);
  return undefined;
}

async function runFlow(ctx: ContextHandle, flow: Flow): Promise<FlowRecord> {
  const decisions: DecisionRecord[] = [];
  let stepIndex = 0;
  let stepNote = "";

  const backstop = new EffectBackstop(ctx.cdp(), {
    taskOrigin: flow.url,
    windowMs: WINDOW_MS,
    // Nothing is approved: this run measures WHAT WOULD BE ASKED, and a real
    // approval would change the page and make later steps incomparable.
    onEscalate: () => Promise.resolve(false),
    onDecision: (req: PausedRequest, held: boolean) => {
      decisions.push({
        flow: flow.id,
        step: stepIndex,
        stepNote,
        held,
        method: req.method,
        url: req.url.slice(0, 200),
        resourceType: req.resourceType,
        reason: req.reason,
      });
    },
  });

  let stepsRun = 0;
  let stepsSkipped = 0;
  try {
    await ctx.navigate(flow.url);
    await ctx.cdp().send("Emulation.setDeviceMetricsOverride", VIEWPORT);
    await backstop.observe();
    // Watch the page be itself first. Autosave, heartbeats and analytics all
    // announce themselves here, and that is what the baseline is made of.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    for (const [i, step] of flow.steps.entries()) {
      stepIndex = i + 1;
      stepNote = step.note;
      if (step.kind === "wait") {
        await new Promise((r) => setTimeout(r, step.ms));
        continue;
      }

      const found = step.kind === "enter" ? undefined : await findTarget(ctx, step.role, step.label);
      if (step.kind !== "enter" && found === undefined) {
        stepsSkipped += 1;
        continue;
      }

      await backstop.arm();
      try {
        if (step.kind === "click" || step.kind === "type") {
          const point = await pointerPointFor(ctx.cdp(), found!.backendNodeId, `${step.role}:${step.label.source}`);
          for (const type of ["mousePressed", "mouseReleased"]) {
            await ctx.cdp().send("Input.dispatchMouseEvent", {
              type,
              x: point.x,
              y: point.y,
              button: "left",
              clickCount: 1,
            });
          }
          if (step.kind === "type") {
            // Character by character: a typeahead fires per keystroke, which is
            // the realistic load for this measurement.
            for (const ch of step.value) {
              await ctx.cdp().send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
              await ctx.cdp().send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
              await new Promise((r) => setTimeout(r, 60));
            }
          }
        } else {
          await ctx.cdp().send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13 });
          await ctx.cdp().send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
        }
        stepsRun += 1;
        await new Promise((r) => setTimeout(r, WINDOW_MS));
      } finally {
        await backstop.disarm();
      }
    }

    const stats = backstop.stats();
    await backstop.dispose();
    return {
      flow: flow.id,
      kind: flow.kind,
      lang: flow.lang,
      url: flow.url,
      ok: true,
      stepsRun,
      stepsSkipped,
      examined: stats.seen,
      escalated: stats.held,
      baseline: stats.baseline,
      latencyP50: percentile(stats.latencies, 50),
      latencyP95: percentile(stats.latencies, 95),
      decisions,
    };
  } catch (err) {
    const stats = backstop.stats();
    await backstop.dispose().catch(() => undefined);
    return {
      flow: flow.id,
      kind: flow.kind,
      lang: flow.lang,
      url: flow.url,
      ok: false,
      error: `${(err as Error).message}`.slice(0, 200),
      stepsRun,
      stepsSkipped,
      examined: stats.seen,
      escalated: stats.held,
      baseline: stats.baseline,
      latencyP50: percentile(stats.latencies, 50),
      latencyP95: percentile(stats.latencies, 95),
      decisions,
    };
  }
}

export async function runBackstopField(outPath: string): Promise<FlowRecord[]> {
  const executablePath = detectChromiumExecutable();
  const adapter: EngineAdapter = createEngineAdapter();
  await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const records: FlowRecord[] = [];
  try {
    for (const flow of FLOWS) {
      const ctx = await adapter.createContext();
      try {
        const rec = await runFlow(ctx, flow);
        records.push(rec);
        process.stderr.write(
          `${rec.flow}: ok=${rec.ok} steps=${rec.stepsRun}(+${rec.stepsSkipped} skipped) ` +
            `examined=${rec.examined} escalated=${rec.escalated} baseline=${rec.baseline} ` +
            `p50=${rec.latencyP50.toFixed(1)}ms p95=${rec.latencyP95.toFixed(1)}ms${rec.error ? ` ${rec.error}` : ""}\n`,
        );
      } finally {
        await ctx.close().catch(() => undefined);
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(records, null, 1));
    }
  } finally {
    await adapter.shutdown();
  }
  return records;
}
