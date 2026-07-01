/**
 * Live zero-orphan proof (opt-in: LATTICE_LIVE_ENGINE=1). Drives real
 * agent-browser Chrome and asserts a create→act→destroy leaves ZERO of OUR
 * agent-browser processes — checking the process list, not just a daemon exit.
 * Scoped to our cwd via reapTargets, so a concurrently-running desktop app
 * (engine under /Applications) is neither counted nor killed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { AgentBrowserEngine } from "@lattice/engine-adapter";
import { parsePs, reapTargets, reapEngineProcesses, type ReapHost } from "./reap.js";

const live = process.env["LATTICE_LIVE_ENGINE"] === "1" ? describe : describe.skip;

// vitest runs from apps/serve; the agent-browser binary resolves under the repo
// root's node_modules, so scope to the install root (as production `serve` does,
// launched from the install root / desktop backend dir where cwd is an ancestor).
const ROOT = resolve(process.cwd(), "..", "..");
const ps = (): string => execSync("ps -axo pid=,ppid=,command=", { encoding: "utf8" });
/** OUR agent-browser processes (daemon + Chrome), scoped to the install root. */
const ours = () => reapTargets(parsePs(ps()), ROOT, process.pid);
const host: ReapHost = { ps, kill: (pid) => process.kill(pid, "SIGKILL"), cwd: ROOT, selfPid: process.pid };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

live("reap — live zero-orphan", () => {
  beforeAll(() => {
    // Clean any lingering dev daemon/Chrome from earlier runs so the assertions
    // measure THIS test's processes only.
    reapEngineProcesses(host);
  });

  it("graceful create→act→destroy leaves ZERO of our agent-browser processes", async () => {
    const engine = new AgentBrowserEngine({ timeoutMs: 60_000 });
    await engine.launch();
    const s = await engine.createSession();
    await s.navigate("data:text/html,<h1>hi</h1><form><input aria-label=U><button>Go</button></form>");
    await s.snapshot();

    const during = ours();
    expect(during.daemons.length).toBeGreaterThan(0); // our daemon is live
    expect(during.chrome.length).toBeGreaterThan(0); // its Chrome is live

    await s.close();
    await engine.shutdown();
    await sleep(2000);

    const after = ours();
    expect(after.daemons).toEqual([]); // daemon gone
    expect(after.chrome).toEqual([]); // Chrome gone — no orphan (graceful close reaped)
  }, 90_000);

  it("the reap kills a session's daemon+Chrome when graceful close is SKIPPED (crash path)", async () => {
    const engine = new AgentBrowserEngine({ timeoutMs: 60_000 });
    await engine.launch();
    const s = await engine.createSession();
    await s.navigate("data:text/html,<h1>hi</h1>");
    await s.snapshot();
    expect(ours().daemons.length).toBeGreaterThan(0);

    // Simulate an ungraceful exit: reap WITHOUT calling close()/shutdown().
    const killed = reapEngineProcesses(host);
    expect(killed.daemons.length).toBeGreaterThan(0); // daemon (the resurrector) killed first
    await sleep(2000);

    const after = ours();
    expect(after.daemons).toEqual([]);
    expect(after.chrome).toEqual([]); // Chrome did NOT respawn (daemon was killed first)
  }, 90_000);
});
