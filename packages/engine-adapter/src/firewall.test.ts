/**
 * ADR 0002 negative tests — the kernel-bypass primitives of agent-browser are
 * unreachable through the Lattice engine seam.
 *
 * These are pure unit tests (no live browser): the firewall refuses the command
 * BEFORE the engine process is ever spawned, which is the whole point — the
 * refusal does not depend on the engine being up.
 */

import { describe, it, expect } from "vitest";
import {
  assertNotFirewalled,
  EngineFirewallError,
  FIREWALLED_FLAGS,
  FIREWALLED_SUBCOMMANDS,
} from "./firewall.js";
import { AgentBrowserProcess } from "./process.js";
import { AgentBrowserEngine } from "./adapter.js";
import type { AbEnvelope, AbRunner } from "./types.js";

describe("engine firewall — kernel-bypass primitives refused (ADR 0002 §3)", () => {
  it("refuses every firewalled subcommand", () => {
    for (const sub of FIREWALLED_SUBCOMMANDS) {
      expect(() => assertNotFirewalled(sub, [])).toThrow(EngineFirewallError);
    }
  });

  it("refuses arbitrary JS (eval) — the live escape hatch we proved returns results", () => {
    expect(() => assertNotFirewalled("eval", ["1+1"])).toThrow(/eval.*firewalled/i);
  });

  it("refuses raw CDP attach (connect) and the cdp-url leak (get cdp-url)", () => {
    expect(() => assertNotFirewalled("connect", ["9222"])).toThrow(EngineFirewallError);
    expect(() => assertNotFirewalled("get", ["cdp-url"])).toThrow(/get cdp-url/i);
  });

  it("refuses every firewalled flag, including the =value form", () => {
    for (const flag of FIREWALLED_FLAGS) {
      expect(() => assertNotFirewalled("open", ["http://x", flag])).toThrow(EngineFirewallError);
      expect(() => assertNotFirewalled("open", ["http://x", `${flag}=/tmp/x`])).toThrow(
        EngineFirewallError,
      );
    }
  });

  it("refuses file access, profile import, and plaintext state load specifically", () => {
    expect(() => assertNotFirewalled("open", ["file:///etc/passwd", "--allow-file-access"])).toThrow();
    expect(() => assertNotFirewalled("snapshot", ["--profile", "Default"])).toThrow();
    expect(() => assertNotFirewalled("open", ["http://x", "--state", "/tmp/auth.json"])).toThrow();
  });

  it("allows the safe semantic surface", () => {
    expect(() => assertNotFirewalled("open", ["https://example.com"])).not.toThrow();
    expect(() => assertNotFirewalled("snapshot", ["-i"])).not.toThrow();
    expect(() => assertNotFirewalled("find", ["role", "button", "click"])).not.toThrow();
    expect(() => assertNotFirewalled("get", ["url"])).not.toThrow();
    expect(() => assertNotFirewalled("read", [])).not.toThrow();
  });

  it("the process runner enforces the firewall before spawning (no browser needed)", async () => {
    // binaryPath override avoids touching a real binary; the firewall short-circuits.
    const proc = new AgentBrowserProcess({ binaryPath: "/nonexistent/agent-browser" });
    await expect(proc.run("s", "eval", ["fetch('http://evil')"])).rejects.toThrow(
      EngineFirewallError,
    );
    await expect(proc.run("s", "connect", ["9222"])).rejects.toThrow(EngineFirewallError);
    await expect(proc.run("s", "get", ["cdp-url"])).rejects.toThrow(EngineFirewallError);
  });
});

describe("engine seam — structurally omits bypass surface (ADR 0002 §1)", () => {
  const calls: string[] = [];
  const recording: AbRunner = {
    run(_s, sub): Promise<AbEnvelope> {
      calls.push(sub);
      return Promise.resolve({ success: true, data: {}, error: null });
    },
  };

  it("exposes no method that could route eval/cdp/file — the surface is the guarantee", async () => {
    const engine = new AgentBrowserEngine({ runner: recording });
    await engine.launch();
    const session = await engine.createSession();
    // The EngineSession type has exactly these operations; there is no `eval`,
    // `cdp`, `connect`, or `file` member to call.
    const keys = ["navigate", "currentUrl", "snapshot", "readText", "act", "close"];
    for (const k of keys) expect(typeof (session as unknown as Record<string, unknown>)[k]).toBe("function");
    expect((session as unknown as Record<string, unknown>)["eval"]).toBeUndefined();
    expect((session as unknown as Record<string, unknown>)["cdp"]).toBeUndefined();
  });

  it("session names are private, unguessable, and carry no exposed port", async () => {
    const engine = new AgentBrowserEngine({ runner: recording });
    await engine.launch();
    const a = await engine.createSession();
    const b = await engine.createSession();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^lattice-[0-9a-f-]{36}$/);
    // No port/socket is part of the session identity — the only door is the
    // adapter. A host:port handle would contain a colon; a private name does not.
    expect(String(a.id)).not.toContain(":");
  });
});
