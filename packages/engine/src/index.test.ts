import { describe, it, expect } from "vitest";
import type { BrowserContextId, EngineConfig } from "./index.js";
import { createEngineAdapter } from "./index.js";

describe("@lattice/engine scaffold", () => {
  it("EngineConfig accepts headless flag", () => {
    const config: EngineConfig = { headless: true };
    expect(config.headless).toBe(true);
  });

  it("createEngineAdapter throws NotImplemented until S1", () => {
    expect(() => createEngineAdapter()).toThrow("Not implemented");
  });

  it("BrowserContextId is a branded string at runtime", () => {
    const id = "ctx-1" as unknown as BrowserContextId;
    expect(typeof id).toBe("string");
  });
});
