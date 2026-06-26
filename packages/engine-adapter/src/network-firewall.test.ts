import { describe, it, expect } from "vitest";
import { assertNotFirewalled, EngineFirewallError } from "./firewall.js";

// Task 2 hardening: `network` (route/abort/mock) is a traffic-manipulation
// primitive — the agent must never reach it through the engine adapter.
describe("firewall — network subcommand is agent-inaccessible", () => {
  it("rejects `network route ... --abort` and `network route ... --body`", () => {
    expect(() => assertNotFirewalled("network", ["route", "https://x/**", "--abort"])).toThrow(EngineFirewallError);
    expect(() => assertNotFirewalled("network", ["route", "**/api", "--body", "{}"])).toThrow(EngineFirewallError);
    expect(() => assertNotFirewalled("network", ["unroute"])).toThrow(EngineFirewallError);
  });
  it("still allows benign navigation/snapshot subcommands", () => {
    expect(() => assertNotFirewalled("open", ["https://example.com"])).not.toThrow();
    expect(() => assertNotFirewalled("snapshot", ["-i"])).not.toThrow();
  });
});
