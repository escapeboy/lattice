/**
 * S1 live integration — drives the real agent-browser engine end-to-end.
 *
 * Opt-in via LATTICE_LIVE_ENGINE=1 (the engine downloads Chrome for Testing on
 * first run, which must not block CI). When enabled it launches a real browser,
 * navigates, snapshots, acts, and reads — proving the adapter against the actual
 * binary, not a fake.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentBrowserEngine } from "./adapter.js";
import type { EngineSession } from "./types.js";

const liveEnabled = process.env["LATTICE_LIVE_ENGINE"] === "1";
const describeLive = liveEnabled ? describe : describe.skip;

const PAGE =
  "data:text/html,<form><input aria-label=Name><button>Go</button></form>";

describeLive("@lattice/engine-adapter — live (S1)", () => {
  const engine = new AgentBrowserEngine({ timeoutMs: 60_000 });
  let session: EngineSession;

  beforeAll(async () => {
    await engine.launch();
    session = await engine.createSession();
  }, 90_000);

  afterAll(async () => {
    await engine.shutdown().catch(() => undefined);
  });

  it("navigates and reports the landed url", async () => {
    const res = await session.navigate(PAGE);
    expect(res.url).toContain("data:text/html");
  });

  it("snapshots the accessibility tree with stable-within-snapshot refs", async () => {
    const snap = await session.snapshot();
    const roles = snap.refs.map((r) => r.role);
    expect(roles).toContain("button");
    expect(roles).toContain("textbox");
    expect(snap.tree).toMatch(/\[ref=e\d+\]/);
  });

  it("fills a field by label and clicks a button by role (trusted input)", async () => {
    const fill = await session.act({
      type: "fill",
      target: { kind: "label", value: "Name" },
      value: "Ada",
    });
    expect(fill.ok).toBe(true);
    const click = await session.act({ type: "click", target: { kind: "role", value: "button" } });
    expect(click.ok).toBe(true);
  });

  it("reads agent-readable text", async () => {
    const text = await session.readText();
    expect(text).toContain("Go");
  });
});
