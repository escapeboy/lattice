/**
 * A human grant must not land on a different target than the one approved.
 *
 * The human approves "Delete" on the Alpha row. While they think, the page
 * re-renders the list. When the click finally dispatches it must either hit
 * Alpha or refuse — never delete another row under an approval for Alpha.
 *
 * Opt-in via LATTICE_LIVE_ENGINE=1: drives the real agent-browser binary,
 * because the question is how ITS refs resolve after a re-render.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BuildOnSession } from "./build-on-session.js";
import { createSecurityKernel } from "@lattice/kernel";
import type { GrantDecision } from "@lattice/kernel";
import { AgentBrowserEngine } from "@lattice/engine-adapter";

const live = process.env["LATTICE_LIVE_ENGINE"] === "1" ? describe : describe.skip;

/** Rows re-render `afterMs` after load; a click reports the row it landed in. */
function page(mode: "rebuild" | "reuse", unique: boolean, afterMs: number, nameAfter = false): string {
  const html = `<!doctype html><title>rows</title>
<ul id=list></ul><p id=out>none</p>
<script>
const list = document.getElementById('list');
const btn = (name) => '<button' + (${unique} ? ' aria-label="Delete ' + name + '"' : '') + '>Delete</button>';
const render = (names) => {
  list.innerHTML = names
    .map((n) => '<li>' + (${nameAfter} ? btn(n) + ' <span>' + n + '</span>' : '<span>' + n + '</span> ' + btn(n)) + '</li>')
    .join('');
};
render(['Alpha', 'Beta', 'Gamma']);
document.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) document.getElementById('out').textContent = 'deleted:' + li.querySelector('span').textContent;
});
setTimeout(() => {
  if (${mode === "rebuild"}) { render(['Gamma', 'Alpha', 'Beta']); return; }
  // Same DOM nodes, new content: what a virtualised list does on scroll.
  const next = ['Gamma', 'Alpha', 'Beta'];
  list.querySelectorAll('li').forEach((li, i) => {
    li.querySelector('span').textContent = next[i];
    if (${unique}) li.querySelector('button').setAttribute('aria-label', 'Delete ' + next[i]);
  });
}, ${afterMs});
</script>`;
  return "data:text/html," + encodeURIComponent(html);
}

live("grant target guard (live)", () => {
  const engine = new AgentBrowserEngine({ timeoutMs: 60_000 });

  beforeAll(async () => {
    await engine.launch();
  }, 90_000);

  afterAll(async () => {
    await engine.shutdown().catch(() => undefined);
  });

  const cases: Array<["rebuild" | "reuse", boolean, boolean]> = [];
  for (const mode of ["rebuild", "reuse"] as const)
    for (const unique of [false, true]) for (const nameAfter of [false, true]) cases.push([mode, unique, nameAfter]);

  it("a page that stays still is not refused", async () => {
    const k = createSecurityKernel({
      allowedOrigins: [],
      egressAllowlist: [],
      prohibitedActions: [],
      grantHandler: async (): Promise<GrantDecision> => {
        await new Promise((r) => setTimeout(r, 500));
        return { granted: true, grantId: "human" };
      },
    });
    const es = await engine.createSession();
    const s = new BuildOnSession(es, k, { origin: "data:", sessionId: "guard-still" });
    try {
      // The re-render is scheduled long after the test ends.
      await s.act({ type: "navigate", url: page("rebuild", false, 600_000) });
      const ig = await s.perceive();
      const alpha = [...ig.graph.nodes.values()].find((n) => n.role === "button")!;
      const res = await s.act({ type: "act", target: { nodeId: alpha.id } });
      expect(res.gated).toBe(true);
      expect(/deleted:(\w+)/.exec(await es.readText())?.[1]).toBe("Alpha");
    } finally {
      await es.close().catch(() => undefined);
    }
  }, 60_000);

  for (const [mode, unique, nameAfter] of cases) {
    const shape = `${mode}, ${unique ? "unique" : "identical"} labels, name ${nameAfter ? "after" : "before"} the button`;
    it(`${shape}: refused, nothing deleted`, async () => {
      let approvals = 0;
      const k = createSecurityKernel({
        allowedOrigins: [],
        egressAllowlist: [],
        prohibitedActions: [],
        grantHandler: async (): Promise<GrantDecision> => {
          approvals++;
          // The human takes longer to decide than the page takes to re-render.
          await new Promise((r) => setTimeout(r, 2500));
          return { granted: true, grantId: "human" };
        },
      });
      const es = await engine.createSession();
      const s = new BuildOnSession(es, k, { origin: "data:", sessionId: `guard-${mode}-${unique}-${nameAfter}` });
      try {
        await s.act({ type: "navigate", url: page(mode, unique, 1200, nameAfter) });
        const ig = await s.perceive();
        const buttons = [...ig.graph.nodes.values()].filter((n) => n.role === "button");
        const alpha = unique ? buttons.find((n) => n.label === "Delete Alpha")! : buttons[0]!;

        const outcome = await s.act({ type: "act", target: { nodeId: alpha.id } }).then(
          () => "executed",
          (e: Error) => `refused: ${e.message}`,
        );
        const text = await es.readText();
        const deleted = /deleted:(\w+)/.exec(text)?.[1] ?? "none";

        // Before the guard, 3 of the 4 name-before shapes deleted Gamma here.
        expect(approvals).toBe(1);
        expect(outcome).toMatch(/^refused: target changed while waiting for approval/);
        expect(deleted).toBe("none");
      } finally {
        await es.close().catch(() => undefined);
      }
    }, 60_000);
  }
});
