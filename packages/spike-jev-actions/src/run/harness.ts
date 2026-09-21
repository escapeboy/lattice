/**
 * Browser harness for every live run in this spike.
 *
 * Isolation: Lattice's own engine adapter launches Chromium through
 * playwright-core with a fresh temporary profile and then opens a NEW context
 * per run. No persona, no vault, no imported Chrome profile, no logged-in
 * state — which is the boundary this spike runs under.
 */

import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { InteractionGraph, PerceptionEngine } from "@lattice/perception";
import { createActionEngine } from "@lattice/action";
import type { ActionEngine } from "@lattice/action";
import { buildElementTable, type ElementTable, type Viewport } from "../element-table.js";

export interface Run {
  readonly ctx: ContextHandle;
  readonly perception: PerceptionEngine;
  readonly action: ActionEngine;
  viewport(): Promise<Viewport>;
  perceive(): Promise<{ ig: InteractionGraph; table: ElementTable; browserMs: number }>;
  /** Visible rendered text, as a practical agent would include in its state. */
  pageText(): Promise<string>;
  /** Reads the fixture's click recorder, which records the last activated label. */
  actedLabel(): Promise<string | null>;
  close(): Promise<void>;
}

export interface Harness {
  open(url: string, opts?: { dismissInterstitial?: boolean }): Promise<{
    run: Run;
    navigateMs: number;
    interstitialDismissed: boolean;
  }>;
  shutdown(): Promise<void>;
}

/**
 * Click a consent/cookie wall's refuse button, if one is on the page.
 *
 * Phase 0 runs against a Chrome profile where this banner was dismissed once by
 * hand; a fresh Playwright context meets it on every run. Leaving it in place
 * would compare "an agent doing the task" against "an agent staring at a cookie
 * wall". This is fixture setup, not a model-chosen action — the model never
 * emits JavaScript.
 */
const DISMISS_JS = `(() => {
  const wanted = /^(reject all|reject|decline|only necessary|alle ablehnen|accept all)$/i;
  const nodes = [...document.querySelectorAll('button, [role=button], input[type=submit], a')];
  for (const n of nodes) {
    const t = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
    if (wanted.test(t)) { n.click(); return t; }
  }
  return null;
})()`;

export async function startHarness(headless = true): Promise<Harness> {
  const adapter: EngineAdapter = createEngineAdapter();
  const executablePath = detectChromiumExecutable();
  await adapter.launch({
    headless,
    ...(executablePath !== undefined ? { executablePath } : {}),
  });

  return {
    async open(url: string, opts: { dismissInterstitial?: boolean } = {}) {
      const ctx = await adapter.createContext();
      const startedNav = performance.now();
      await ctx.navigate(url);
      const navigateMs = performance.now() - startedNav;
      const cdp = ctx.cdp();

      let interstitialDismissed = false;
      if (opts.dismissInterstitial) {
        for (let attempt = 0; attempt < 2 && !interstitialDismissed; attempt++) {
          const r = await cdp
            .send<{ result?: { value?: string | null } }>("Runtime.evaluate", {
              expression: DISMISS_JS,
              returnByValue: true,
            })
            .catch(() => ({ result: { value: null } }));
          if (r.result?.value) {
            interstitialDismissed = true;
            await new Promise((res) => setTimeout(res, 2500));
          } else {
            await new Promise((res) => setTimeout(res, 800));
          }
        }
      }
      const perception = createPerceptionEngine(cdp);
      const action = createActionEngine(cdp, ctx, perception);

      const FALLBACK_VIEWPORT: Viewport = {
        width: 1280, height: 720, scrollX: 0, scrollY: 0, scrollHeight: 720,
      };
      const viewport = async (): Promise<Viewport> => {
        // A navigation in flight can make Runtime.evaluate resolve with no
        // value; reading `.height` off that crashed a whole task run once.
        // Degrade to a default viewport instead of killing the run.
        try {
          const res = await cdp.send<{ result?: { value?: Viewport } }>("Runtime.evaluate", {
            expression:
              "({width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)})",
            returnByValue: true,
          });
          const v = res.result?.value;
          return v && typeof v.height === "number" ? v : FALLBACK_VIEWPORT;
        } catch {
          return FALLBACK_VIEWPORT;
        }
      };

      const run: Run = {
        ctx,
        perception,
        action,
        viewport,
        async perceive() {
          const started = performance.now();
          const ig = (await perception.snapshot("L1")) as InteractionGraph;
          const vp = await viewport();
          const browserMs = performance.now() - started;
          return { ig, table: buildElementTable(ig, vp), browserMs };
        },
        async pageText() {
          const res = await cdp
            .send<{ result: { value: string } }>("Runtime.evaluate", {
              expression: "document.body ? document.body.innerText : ''",
              returnByValue: true,
            })
            .catch(() => ({ result: { value: "" } }));
          return res.result.value ?? "";
        },
        async actedLabel() {
          const res = await cdp
            .send<{ result: { value: string | null } }>("Runtime.evaluate", {
              expression: "window.__fixtureActed ?? null",
              returnByValue: true,
            })
            .catch(() => ({ result: { value: null } }));
          return res.result.value;
        },
        close: () => ctx.close(),
      };
      return { run, navigateMs, interstitialDismissed };
    },
    shutdown: () => adapter.shutdown(),
  };
}
