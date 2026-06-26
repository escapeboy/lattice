/**
 * S4 (concurrency governor + fan-out) and S7 (trace emission) over the build-on
 * stack (ADR 0002), with a fake engine — no browser.
 */

import { describe, it, expect } from "vitest";
import { BuildOnSessionRegistry, SessionBudgetError } from "./build-on-registry.js";
import { fanOut } from "./build-on-fanout.js";
import { createSecurityKernel } from "@lattice/kernel";
import type { InteractionGraph } from "@lattice/perception";
import type {
  SemanticEngine,
  EngineSession,
  NavResult,
  RawSnapshot,
  ActionResult,
} from "@lattice/engine-adapter";

class FakeEngine implements SemanticEngine {
  created = 0;
  sessions: FakeSession[] = [];
  launch(): Promise<void> {
    return Promise.resolve();
  }
  createSession(): Promise<EngineSession> {
    this.created += 1;
    const s = new FakeSession();
    this.sessions.push(s);
    return Promise.resolve(s);
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSession implements EngineSession {
  readonly id = `s${Math.floor(performance.now() * 1000) % 100000}` as EngineSession["id"];
  closed = false;
  navigate(url: string): Promise<NavResult> {
    return Promise.resolve({ url, title: "" });
  }
  currentUrl(): Promise<string> {
    return Promise.resolve("https://x/");
  }
  snapshot(): Promise<RawSnapshot> {
    return Promise.resolve({ url: "https://x/", refs: [], tree: '- button "Go" [ref=e1]' });
  }
  readText(): Promise<string> {
    return Promise.resolve("t");
  }
  screenshot(): Promise<string> {
    return Promise.resolve("B64");
  }
  act(): Promise<ActionResult> {
    return Promise.resolve({ ok: true, url: "https://x/", error: undefined });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const kernel = () => createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });

describe("BuildOnSessionRegistry — resource governor (S4)", () => {
  it("caps concurrent sessions at the budget", async () => {
    const reg = new BuildOnSessionRegistry(new FakeEngine(), kernel(), { maxSessions: 2 });
    await reg.create();
    await reg.create();
    await expect(reg.create()).rejects.toBeInstanceOf(SessionBudgetError);
    expect(reg.activeCount()).toBe(2);
  });

  it("frees a slot on destroy", async () => {
    const reg = new BuildOnSessionRegistry(new FakeEngine(), kernel(), { maxSessions: 1 });
    const s = await reg.create();
    await expect(reg.create()).rejects.toBeInstanceOf(SessionBudgetError);
    await reg.destroy(s.id);
    await expect(reg.create()).resolves.toBeDefined();
  });
});

describe("fanOut — one task, many governed sessions (S4)", () => {
  it("runs a worker across items and aggregates results in order", async () => {
    const engine = new FakeEngine();
    const reg = new BuildOnSessionRegistry(engine, kernel(), { maxSessions: 10 });
    const urls = ["https://a/", "https://b/", "https://c/"];

    const results = await fanOut(reg, urls, async (session, url) => {
      const ig = (await session.perception.snapshot("L1")) as InteractionGraph;
      return { url, buttons: [...ig.nodes.values()].filter((n) => n.role === "button").length };
    });

    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(results.map((r) => r.value?.url)).toEqual(urls);
    expect(results.every((r) => r.value?.buttons === 1)).toBe(true);
    // Every fanned-out session was torn down.
    expect(reg.activeCount()).toBe(0);
    expect(engine.sessions.every((s) => s.closed)).toBe(true);
  });

  it("isolates failures: a throwing worker yields ok:false without sinking the batch", async () => {
    const reg = new BuildOnSessionRegistry(new FakeEngine(), kernel(), { maxSessions: 10 });
    const results = await fanOut(reg, [1, 2, 3], async (session, n) => {
      await session.perception.snapshot("L1");
      if (n === 2) throw new Error("boom");
      return n * 10;
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[0]?.value).toBe(10);
    expect(results[1]?.error).toMatch(/boom/);
    expect(reg.activeCount()).toBe(0);
  });
});

describe("build-on trace emission (S7)", () => {
  it("a perceive→act→destroy cycle finalizes a structured trace", async () => {
    const reg = new BuildOnSessionRegistry(new FakeEngine(), kernel());
    const session = await reg.create();
    // Drive perception + action so the recorder captures events.
    const ig = (await session.perception.snapshot("L1")) as InteractionGraph;
    session.lastSnapshot = ig;
    session.recorder.recordSnapshot(ig.tier, ig.url, ig.title, [...ig.nodes.values()]);
    const buttonId = [...ig.nodes.values()].find((n) => n.role === "button")!.id;
    await session.action.execute({ type: "act", target: { nodeId: buttonId } });
    session.recorder.recordActionResult(true, ig.url, undefined);

    const trace = await reg.destroy(session.id);
    expect(trace).toBeDefined();
    expect(trace!.sessionId).toBe(session.id);
    expect(trace!.events.length).toBeGreaterThan(0);
  });
});
