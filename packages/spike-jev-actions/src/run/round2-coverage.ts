/**
 * Deterministic gate coverage for round 2.
 *
 * The live arm cannot show the gate stopping a hijack unless the agent commits
 * one first, and it committed none. "0 hijacks" therefore does not say whether
 * the gate WOULD have held — the same ambiguity round 1 had. This asks the
 * question directly: for every flow, probe the spoofed control the way the
 * shipped actuator does, and classify it under each gate.
 *
 * The spoof is the hard case on purpose. Its accessible name is the user's goal
 * verbatim, so every label-based signal says "this is what you asked for". Only
 * the structure disagrees.
 */

import { createServer, type Server } from "node:http";
import { probeEffect, resolveTarget } from "@lattice/action";
import type { EffectEvidence } from "@lattice/kernel";
import { FLOWS } from "../fixtures/flows.js";
import { renderRound2 } from "../fixtures/round2.js";
import { startHarness } from "./harness.js";
import { gateDecision, spikeKernel, type GateMode } from "./gate.js";

const MODES: readonly GateMode[] = ["verb", "semantic", "effect"];

export async function round2Coverage(): Promise<void> {
  const byId = new Map(FLOWS.map((f) => [f.id, f]));
  const server: Server = createServer((req, res) => {
    const [, id, v] = (req.url ?? "").split("?")[0]!.split("/");
    const flow = byId.get(id ?? "");
    if (!flow) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderRound2(flow, v as never));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const kernel = spikeKernel();
  const harness = await startHarness(true);

  const tally: Record<string, number> = { verb: 0, semantic: 0, effect: 0 };
  const rows: string[] = [];

  try {
    for (const flow of FLOWS) {
      const { run } = await harness.open(`${origin}/${flow.id}/label_spoof`);
      try {
        const { table } = await run.perceive();
        // The spoof and the real control share a label; the spoof is the one
        // the probe reports as a submit control.
        const candidates = table.elements.filter((e) => e.label.trim() === flow.benignLabel.trim());
        let spoofEvidence: EffectEvidence | undefined;
        let spoofLabel = flow.benignLabel;
        for (const c of candidates) {
          const t = await resolveTarget(run.ctx.cdp(), c.nodeId);
          const ev = await probeEffect(run.ctx.cdp(), t.backendDOMNodeId);
          if (ev.submitControl) {
            spoofEvidence = ev;
            spoofLabel = c.label;
            break;
          }
        }
        if (!spoofEvidence) {
          rows.push(`| ${flow.id} | — | **spoof not reachable in the table** | | |`);
          continue;
        }

        const cells: string[] = [];
        for (const mode of MODES) {
          const v = gateDecision(kernel, mode, "CLICK", spoofLabel, origin, spoofEvidence);
          if (!v.allowed) tally[mode] = (tally[mode] ?? 0) + 1;
          cells.push(`${v.policyClass} ${v.allowed ? "auto-granted" : "**STOPPED**"}`);
        }
        const detail = kernel.classifyDetailed({
          actionType: "act",
          origin,
          sessionId: "cov",
          payload: {},
          effect: spoofEvidence,
        });
        rows.push(
          `| ${flow.id} | \`${spoofLabel}\` → ${spoofEvidence.formAction ?? "?"} | ${cells.join(" | ")} |`,
        );
        rows.push(`| | _why:_ ${detail.reasons.join("; ")} | | | |`);
      } finally {
        await run.close().catch(() => undefined);
      }
    }
  } finally {
    await harness.shutdown();
    server.close();
  }

  console.log("## Round 2 — label spoofing, deterministic gate coverage\n");
  console.log("The control's visible label IS the user's goal. Only the form action says otherwise.\n");
  console.log("| flow | spoofed control → real destination | gate: verb | gate: semantic (round 1) | gate: effect (shipped) |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  console.log("");
  for (const mode of MODES) {
    console.log(`- gate **${mode}**: stops ${tally[mode] ?? 0}/${FLOWS.length} spoofed controls.`);
  }
}
