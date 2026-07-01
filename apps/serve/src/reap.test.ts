/**
 * Engine reap targeting — the supervisor kills OUR agent-browser daemon (the
 * resurrector) first, then the Chrome it owns / orphaned Chrome, while sparing
 * another live install's engine (e.g. the desktop app under /Applications).
 */

import { describe, it, expect } from "vitest";
import { parsePs, reapTargets, reapEngineProcesses, type PsRow, type ReapHost } from "./reap.js";

const CWD = "/repo";
const SELF = 999;

// A realistic ps snapshot: our dev daemon (pnpm layout) + its Chrome + a helper,
// a stale orphaned Chrome, and a LIVE desktop-app engine under /Applications.
const rows: PsRow[] = [
  { pid: 100, ppid: 1, command: "/repo/node_modules/.pnpm/agent-browser@0.31.0/node_modules/agent-browser/bin/agent-browser-darwin-arm64" },
  { pid: 101, ppid: 100, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/T/agent-browser-chrome-abc" },
  { pid: 102, ppid: 101, command: "/Applications/Google Chrome.app/.../Google Chrome Helper --type=gpu --user-data-dir=/var/folders/T/agent-browser-chrome-abc" },
  { pid: 200, ppid: 1, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/T/agent-browser-chrome-stale" },
  { pid: 300, ppid: 1, command: "/Applications/Lattice.app/Contents/Resources/backend/node_modules/agent-browser/bin/agent-browser-darwin-arm64" },
  { pid: 301, ppid: 300, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/T/agent-browser-chrome-desktop" },
  { pid: SELF, ppid: 1, command: "node /repo/apps/serve/dist/main.js" },
  { pid: 400, ppid: 1, command: "/usr/bin/unrelated" },
];

describe("reapTargets — scoping", () => {
  it("kills OUR daemon (pnpm path under cwd) and the Chrome it owns + orphaned Chrome", () => {
    const { daemons, chrome } = reapTargets(rows, CWD, SELF);
    expect(daemons).toEqual([100]); // our daemon
    expect(chrome.sort()).toEqual([101, 200]); // our browser (ppid=100) + orphaned (ppid=1)
  });

  it("SPARES a live other-install engine (desktop app under /Applications, ppid=its own daemon)", () => {
    const { daemons, chrome } = reapTargets(rows, CWD, SELF);
    expect(daemons).not.toContain(300); // desktop daemon — not under our cwd
    expect(chrome).not.toContain(301); // desktop's live Chrome — ppid is its own daemon
  });

  it("does NOT target Chrome helpers directly (they cascade when the main browser dies)", () => {
    const { chrome } = reapTargets(rows, CWD, SELF);
    expect(chrome).not.toContain(102); // helper ppid=101 (not our daemon, not 1)
  });

  it("never targets self", () => {
    const { daemons, chrome } = reapTargets(rows, CWD, SELF);
    expect([...daemons, ...chrome]).not.toContain(SELF);
  });

  it("matches the staged desktop layout too when it IS our cwd", () => {
    const desktopCwd = "/Applications/Lattice.app/Contents/Resources/backend";
    const { daemons, chrome } = reapTargets(rows, desktopCwd, SELF);
    expect(daemons).toEqual([300]); // now the desktop daemon is 'ours'
    expect(chrome.sort()).toEqual([200, 301]); // its browser + the orphaned one
  });
});

describe("parsePs", () => {
  it("parses pid/ppid/command lines and ignores junk", () => {
    const out = "  100     1 /repo/node_modules/agent-browser/bin/agent-browser-x\nnot-a-row\n 101 100 chrome\n";
    expect(parsePs(out)).toEqual([
      { pid: 100, ppid: 1, command: "/repo/node_modules/agent-browser/bin/agent-browser-x" },
      { pid: 101, ppid: 100, command: "chrome" },
    ]);
  });
});

describe("reapEngineProcesses — order + best-effort", () => {
  it("kills daemons BEFORE Chrome (so the resurrector can't relaunch it)", () => {
    const killed: number[] = [];
    const host: ReapHost = {
      ps: () => rows.map((r) => `${r.pid} ${r.ppid} ${r.command}`).join("\n"),
      kill: (pid) => { killed.push(pid); },
      cwd: CWD,
      selfPid: SELF,
    };
    const res = reapEngineProcesses(host);
    expect(res.daemons).toEqual([100]);
    expect(res.chrome.sort()).toEqual([101, 200]);
    // Daemon (100) killed first, then the browser pids.
    expect(killed[0]).toBe(100);
    expect(killed.slice(1).sort()).toEqual([101, 200]);
  });

  it("survives a kill that throws (already-gone pid) and a broken ps", () => {
    const host: ReapHost = {
      ps: () => rows.map((r) => `${r.pid} ${r.ppid} ${r.command}`).join("\n"),
      kill: () => { throw new Error("ESRCH"); },
      cwd: CWD,
      selfPid: SELF,
    };
    expect(() => reapEngineProcesses(host)).not.toThrow();
    const broken: ReapHost = { ps: () => { throw new Error("no ps"); }, kill: () => {}, cwd: CWD, selfPid: SELF };
    expect(reapEngineProcesses(broken)).toEqual({ daemons: [], chrome: [] });
  });
});
