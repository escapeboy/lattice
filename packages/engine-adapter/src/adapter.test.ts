/**
 * Adapter unit tests — semantic surface maps to the right agent-browser commands
 * and parses real envelope shapes. A fake runner records the exact argv, so these
 * pin the CLI contract without a live browser.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentBrowserEngine } from "./adapter.js";
import type { AbEnvelope, AbRunner } from "./types.js";

interface Call {
  session: string;
  subcommand: string;
  args: string[];
}

class FakeRunner implements AbRunner {
  calls: Call[] = [];
  next: AbEnvelope = { success: true, data: {}, error: null };
  responder: ((sub: string, args: string[]) => AbEnvelope) | undefined;

  run(session: string, subcommand: string, args: readonly string[]): Promise<AbEnvelope> {
    this.calls.push({ session, subcommand, args: [...args] });
    return Promise.resolve(this.responder ? this.responder(subcommand, [...args]) : this.next);
  }

  last(): Call {
    return this.calls[this.calls.length - 1] as Call;
  }
}

async function makeSession(runner: AbRunner) {
  const engine = new AgentBrowserEngine({ runner });
  await engine.launch();
  return { engine, session: await engine.createSession() };
}

describe("AgentBrowserEngine — command mapping", () => {
  let runner: FakeRunner;
  beforeEach(() => {
    runner = new FakeRunner();
  });

  it("navigate → open, parsing landed url + title", async () => {
    runner.next = {
      success: true,
      data: { url: "https://example.com/landed", title: "Example" },
      error: null,
    };
    const { session } = await makeSession(runner);
    const res = await session.navigate("https://example.com");
    expect(runner.last()).toMatchObject({ subcommand: "open", args: ["https://example.com"] });
    expect(res).toEqual({ url: "https://example.com/landed", title: "Example" });
  });

  it("snapshot → snapshot -i, parsing refs map + tree (real envelope shape)", async () => {
    runner.next = {
      success: true,
      data: {
        origin: "https://example.com/",
        refs: { e1: { name: "Hi", role: "button" }, e2: { name: "L", role: "link" } },
        snapshot: '- button "Hi" [ref=e1]\n- link "L" [ref=e2]',
      },
      error: null,
    };
    const { session } = await makeSession(runner);
    const snap = await session.snapshot();
    expect(runner.last()).toMatchObject({ subcommand: "snapshot", args: ["-i"] });
    expect(snap.url).toBe("https://example.com/");
    expect(snap.refs).toEqual([
      { ref: "e1", role: "button", name: "Hi" },
      { ref: "e2", role: "link", name: "L" },
    ]);
    expect(snap.tree).toContain("[ref=e1]");
  });

  it("snapshot honours compact + depth flags", async () => {
    const { session } = await makeSession(runner);
    await session.snapshot({ interactive: true, compact: true, depth: 5 });
    expect(runner.last().args).toEqual(["-i", "-c", "-d", "5"]);
  });

  it("readText → read, parsing content", async () => {
    runner.next = { success: true, data: { content: "Go" }, error: null };
    const { session } = await makeSession(runner);
    expect(await session.readText()).toBe("Go");
    expect(runner.last().subcommand).toBe("read");
  });

  it("currentUrl → get url", async () => {
    runner.next = { success: true, data: { url: "https://x/" }, error: null };
    const { session } = await makeSession(runner);
    expect(await session.currentUrl()).toBe("https://x/");
    expect(runner.last()).toMatchObject({ subcommand: "get", args: ["url"] });
  });

  it("click by ref → click @ref; click by role → find role <v> click", async () => {
    const { session } = await makeSession(runner);
    await session.act({ type: "click", target: { kind: "ref", ref: "e1" } });
    expect(runner.last()).toMatchObject({ subcommand: "click", args: ["@e1"] });
    await session.act({ type: "click", target: { kind: "role", value: "button" } });
    expect(runner.last()).toMatchObject({ subcommand: "find", args: ["role", "button", "click"] });
  });

  it("fill by ref → fill @ref value; fill by locator → find <loc> <v> fill <value>", async () => {
    const { session } = await makeSession(runner);
    await session.act({ type: "fill", target: { kind: "ref", ref: "e3" }, value: "hello" });
    expect(runner.last()).toMatchObject({ subcommand: "fill", args: ["@e3", "hello"] });
    await session.act({ type: "fill", target: { kind: "label", value: "Name" }, value: "Ada" });
    expect(runner.last()).toMatchObject({ subcommand: "find", args: ["label", "Name", "fill", "Ada"] });
  });

  it("select passes all values; submit activates the control (click)", async () => {
    const { session } = await makeSession(runner);
    await session.act({ type: "select", target: { kind: "ref", ref: "e9" }, values: ["a", "b"] });
    expect(runner.last()).toMatchObject({ subcommand: "select", args: ["@e9", "a", "b"] });
    await session.act({ type: "submit", target: { kind: "role", value: "button", text: "Go" } });
    expect(runner.last()).toMatchObject({ subcommand: "find", args: ["role", "button", "click"] });
  });

  it("scroll + wait map to their commands", async () => {
    const { session } = await makeSession(runner);
    await session.act({ type: "scroll", direction: "down", px: 200 });
    expect(runner.last()).toMatchObject({ subcommand: "scroll", args: ["down", "200"] });
    await session.act({ type: "wait", ms: 500 });
    expect(runner.last()).toMatchObject({ subcommand: "wait", args: ["500"] });
  });

  it("a failed action returns ok:false + error (typed-ish), not a throw", async () => {
    runner.next = { success: false, data: null, error: "element_gone" };
    const { session } = await makeSession(runner);
    const res = await session.act({ type: "click", target: { kind: "ref", ref: "e1" } });
    expect(res).toEqual({ ok: false, url: undefined, error: "element_gone" });
  });

  it("navigate/snapshot throw on a failed envelope", async () => {
    runner.next = { success: false, data: null, error: "net::ERR" };
    const { session } = await makeSession(runner);
    await expect(session.navigate("https://x")).rejects.toThrow(/navigate failed: net::ERR/);
  });

  it("shutdown closes every created session", async () => {
    const { engine, session } = await makeSession(runner);
    const s2 = await engine.createSession();
    runner.calls = [];
    await engine.shutdown();
    const closed = runner.calls.filter((c) => c.subcommand === "close").map((c) => c.session);
    expect(closed.sort()).toEqual([session.id, s2.id].sort());
  });

  it("createSession before launch throws", async () => {
    const engine = new AgentBrowserEngine({ runner });
    await expect(engine.createSession()).rejects.toThrow(/not launched/);
  });

  it("device emulation (S9): launch({device}) applies `set device` per session", async () => {
    const engine = new AgentBrowserEngine({ runner });
    await engine.launch({ device: "iPhone 12" });
    await engine.createSession();
    expect(runner.calls.some((c) => c.subcommand === "set" && c.args.join(" ") === "device iPhone 12")).toBe(true);
  });
});
