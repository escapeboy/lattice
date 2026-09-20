/**
 * Held-out capture for the effect gate.
 *
 * The 150-case set was built from 19 origins, all English documentation and
 * encyclopedia sites, and its gold labels were derived from the control's own
 * label — the same signal the gate reads. Scoring against it is therefore
 * generous by construction. This captures a genuinely held-out set: origins
 * that appear nowhere in it, with a third of the cases in Bulgarian, from the
 * site categories where getting a class wrong actually costs something —
 * banking, commerce, government services, telecom self-care.
 *
 * CAPTURE ONLY. Nothing here clicks, submits or types on a live site: it takes
 * an L1 snapshot and records candidate targets. Every page is public and
 * logged out.
 *
 * The labels are written BY HAND afterwards, from this output, and committed
 * BEFORE the classifier is run over them — so the order is auditable in git and
 * a label cannot have been quietly bent to match a prediction.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { IGNode, InteractionGraph } from "@lattice/perception";
import { probeEffect, resolveTarget } from "@lattice/action";
import type { EffectEvidence } from "@lattice/kernel";

/** Origins the 150-case set already covers. Nothing here may come from them. */
export const USED_ORIGINS: ReadonlySet<string> = new Set([
  "https://en.wikipedia.org",
  "https://developer.mozilla.org",
  "https://www.python.org",
  "https://nodejs.org",
  "https://rust-lang.org",
  "https://go.dev",
  "https://www.mediawiki.org",
  "https://www.debian.org",
  "https://www.postgresql.org",
  "https://git-scm.com",
  "https://www.kernel.org",
  "https://httpd.apache.org",
  "https://www.w3.org",
  "https://curl.se",
  "https://www.sqlite.org",
  "https://www.iana.org",
  "https://www.openstreetmap.org",
  "https://news.ycombinator.com",
  "https://peps.python.org",
]);

interface Source {
  readonly url: string;
  readonly lang: "en" | "bg";
  readonly sector: "banking" | "eshop" | "government" | "telecom" | "saas" | "media" | "dev";
  /** How many cases to take from this page. */
  readonly take: number;
}

const SOURCES: readonly Source[] = [
  // ── Bulgarian: banking login pages, logged out ──────────────────────────
  { url: "https://www.fibank.bg/bg", lang: "bg", sector: "banking", take: 3 },
  { url: "https://www.dskbank.bg/bg", lang: "bg", sector: "banking", take: 3 },
  { url: "https://www.unicreditbulbank.bg/bg/", lang: "bg", sector: "banking", take: 3 },
  { url: "https://www.postbank.bg/bg-BG", lang: "bg", sector: "banking", take: 3 },
  { url: "https://www.ccbank.bg/bg", lang: "bg", sector: "banking", take: 2 },
  // ── Bulgarian: e-shops ──────────────────────────────────────────────────
  { url: "https://www.technopolis.bg/bg/", lang: "bg", sector: "eshop", take: 3 },
  { url: "https://www.ardes.bg/", lang: "bg", sector: "eshop", take: 3 },
  { url: "https://www.ozone.bg/", lang: "bg", sector: "eshop", take: 3 },
  // ── Bulgarian: municipal / state e-services ─────────────────────────────
  { url: "https://egov.bg/wps/portal/egov/home", lang: "bg", sector: "government", take: 3 },
  { url: "https://www.sofia.bg/", lang: "bg", sector: "government", take: 3 },
  { url: "https://www.nap.bg/", lang: "bg", sector: "government", take: 2 },
  // ── Bulgarian: telecom self-care ────────────────────────────────────────
  { url: "https://www.a1.bg/", lang: "bg", sector: "telecom", take: 3 },
  { url: "https://www.vivacom.bg/", lang: "bg", sector: "telecom", take: 3 },
  { url: "https://www.yettel.bg/", lang: "bg", sector: "telecom", take: 2 },
  // ── English: new origins, none in the 150-case set ──────────────────────
  { url: "https://github.com/", lang: "en", sector: "dev", take: 3 },
  { url: "https://stackoverflow.com/", lang: "en", sector: "dev", take: 3 },
  { url: "https://about.gitlab.com/", lang: "en", sector: "dev", take: 2 },
  { url: "https://archive.org/", lang: "en", sector: "media", take: 3 },
  { url: "https://wordpress.org/", lang: "en", sector: "saas", take: 2 },
  { url: "https://www.docker.com/", lang: "en", sector: "saas", take: 2 },
  { url: "https://kubernetes.io/", lang: "en", sector: "dev", take: 2 },
  { url: "https://react.dev/", lang: "en", sector: "dev", take: 2 },
  { url: "https://tailwindcss.com/", lang: "en", sector: "saas", take: 2 },
  { url: "https://www.mozilla.org/en-US/", lang: "en", sector: "media", take: 2 },
  { url: "https://www.bbc.com/news", lang: "en", sector: "media", take: 2 },
];

/**
 * A second pass, on DEEPER pages.
 *
 * The homepage pass came back 54 benign / 6 consequential / 1 prohibited,
 * which is an honest picture of a logged-out landing page and a weak test of
 * the miss side. These are the pages where a logged-out visitor can actually
 * commit something: carts, checkouts, contact and newsletter forms, account
 * creation, application starts. Capture only — nothing is clicked.
 */
const DEEP_SOURCES: readonly Source[] = [
  { url: "https://www.ozone.bg/cart/", lang: "bg", sector: "eshop", take: 3 },
  { url: "https://www.technopolis.bg/bg/kolichka", lang: "bg", sector: "eshop", take: 3 },
  { url: "https://www.emag.bg/cart/products", lang: "bg", sector: "eshop", take: 3 },
  { url: "https://www.fibank.bg/bg/kontakti", lang: "bg", sector: "banking", take: 3 },
  { url: "https://www.postbank.bg/bg-BG/Za-kontakti", lang: "bg", sector: "banking", take: 2 },
  { url: "https://www.a1.bg/contacts", lang: "bg", sector: "telecom", take: 3 },
  { url: "https://www.vivacom.bg/bg/residential/kontakti", lang: "bg", sector: "telecom", take: 2 },
  { url: "https://egov.bg/wps/portal/egov/uslugi", lang: "bg", sector: "government", take: 3 },
  { url: "https://www.sofia.bg/e-services", lang: "bg", sector: "government", take: 2 },
  { url: "https://github.com/signup", lang: "en", sector: "dev", take: 3 },
  { url: "https://stackoverflow.com/users/signup", lang: "en", sector: "dev", take: 3 },
  { url: "https://wordpress.org/support/forums/", lang: "en", sector: "saas", take: 2 },
  { url: "https://www.docker.com/pricing/", lang: "en", sector: "saas", take: 3 },
  { url: "https://archive.org/donate", lang: "en", sector: "media", take: 3 },
  { url: "https://www.mozilla.org/en-US/newsletter/", lang: "en", sector: "media", take: 3 },
];

export interface HeldoutCase {
  readonly id: string;
  readonly source: string;
  readonly origin: string;
  readonly lang: string;
  readonly sector: string;
  /** The pending action, as an agent would send it. */
  readonly action: { readonly verb: string; readonly actionType: string };
  readonly target: {
    readonly role: string;
    readonly label: string;
    readonly href?: string;
    readonly tag?: string;
    readonly inputType?: string;
    readonly submitControl?: boolean;
    readonly formAction?: string;
    readonly inFrame?: boolean;
  };
  /** Text near the control, as the probe read it (truncated). */
  readonly nearbyText?: string;
  /** The full probe output, so the classifier sees exactly what a live run would. */
  readonly evidence: EffectEvidence;
  readonly capturedAt: string;
}

/** Roles worth a case, and the verb an agent would use on each. */
const VERB_FOR_ROLE: Record<string, { verb: string; actionType: string }> = {
  link: { verb: "click", actionType: "act" },
  button: { verb: "click", actionType: "act" },
  checkbox: { verb: "click", actionType: "act" },
  input: { verb: "type into", actionType: "fill" },
  combobox: { verb: "select", actionType: "select" },
  heading: { verb: "read", actionType: "extract" },
};

/**
 * Pick targets that make the set worth labelling: prefer controls whose class
 * is genuinely in question (buttons, form fields, anything whose label carries
 * weight) over the hundredth navigation link, but keep some plain links so the
 * benign side is represented.
 */
function pickTargets(ig: InteractionGraph, take: number): IGNode[] {
  const nodes = [...ig.nodes.values()].filter((n) => {
    if (n.state.hidden || n.state.disabled) return false;
    if (!VERB_FOR_ROLE[n.role]) return false;
    const label = n.label.trim();
    return label.length >= 2 && label.length <= 80;
  });

  const weight = (n: IGNode): number => {
    if (n.role === "button") return 0;
    if (n.role === "input" || n.role === "combobox" || n.role === "checkbox") return 1;
    if (n.role === "link" && n.href && !n.href.startsWith("#")) return 2;
    if (n.role === "heading") return 3;
    return 4;
  };

  const seen = new Set<string>();
  const picked: IGNode[] = [];
  for (const n of [...nodes].sort((a, b) => weight(a) - weight(b))) {
    const key = `${n.role}:${n.label.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(n);
    if (picked.length >= take) break;
  }
  return picked;
}

async function captureOne(ctx: ContextHandle, source: Source, index: number): Promise<HeldoutCase[]> {
  await ctx.navigate(source.url);
  await ctx.cdp().send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((r) => setTimeout(r, 1800));

  const ig = (await createPerceptionEngine(ctx.cdp()).snapshot("L1")) as InteractionGraph;
  const origin = (() => {
    try {
      return new URL(ig.url).origin;
    } catch {
      return source.url;
    }
  })();
  if (USED_ORIGINS.has(origin)) {
    throw new Error(`origin ${origin} is already in the 150-case set`);
  }

  const cases: HeldoutCase[] = [];
  for (const node of pickTargets(ig, source.take)) {
    const verb = VERB_FOR_ROLE[node.role]!;
    let evidence: EffectEvidence;
    try {
      const resolved = await resolveTarget(ctx.cdp(), node.id);
      evidence = await probeEffect(ctx.cdp(), resolved.backendDOMNodeId);
    } catch {
      evidence = { probeFailed: true };
    }
    const slug = origin.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-");
    cases.push({
      id: `${slug}-${String(index).padStart(2, "0")}${String(cases.length + 1).padStart(2, "0")}`,
      source: ig.url,
      origin,
      lang: source.lang,
      sector: source.sector,
      action: verb,
      target: {
        role: node.role,
        label: node.label.trim(),
        ...(node.href !== undefined ? { href: node.href } : {}),
        ...(evidence.tag !== undefined ? { tag: evidence.tag } : {}),
        ...(evidence.inputType !== undefined ? { inputType: evidence.inputType } : {}),
        ...(evidence.submitControl !== undefined ? { submitControl: evidence.submitControl } : {}),
        ...(evidence.formAction !== undefined ? { formAction: evidence.formAction } : {}),
        ...(evidence.inFrame !== undefined ? { inFrame: evidence.inFrame } : {}),
      },
      ...(evidence.nearbyText !== undefined ? { nearbyText: evidence.nearbyText.slice(0, 240) } : {}),
      evidence,
      capturedAt: new Date().toISOString(),
    });
  }
  return cases;
}

export async function captureHeldout(outPath: string, deep = false): Promise<HeldoutCase[]> {
  const executablePath = detectChromiumExecutable();
  const adapter: EngineAdapter = createEngineAdapter();
  await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const all: HeldoutCase[] = [];
  const sources = deep ? DEEP_SOURCES : SOURCES;
  try {
    for (const [i, source] of sources.entries()) {
      const ctx = await adapter.createContext();
      try {
        const cases = await captureOne(ctx, source, (deep ? 50 : 0) + i + 1);
        all.push(...cases);
        process.stderr.write(`${source.url}: ${cases.length} cases\n`);
      } catch (err) {
        process.stderr.write(`${source.url}: FAILED ${(err as Error).message.slice(0, 120)}\n`);
      } finally {
        await ctx.close().catch(() => undefined);
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, all.map((c) => JSON.stringify(c)).join("\n") + "\n");
    }
  } finally {
    await adapter.shutdown();
  }
  process.stderr.write(`\ncaptured ${all.length} cases from ${new Set(all.map((c) => c.origin)).size} origins\n`);
  return all;
}
