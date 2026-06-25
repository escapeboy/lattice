import { describe, it, expect } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "./index.js";
import type { BrowserContextId, EngineConfig } from "./index.js";

describe("@lattice/engine unit", () => {
  it("EngineConfig type accepts headless flag", () => {
    const config: EngineConfig = { headless: true };
    expect(config.headless).toBe(true);
  });

  it("EngineConfig accepts optional executablePath", () => {
    const config: EngineConfig = { headless: false, executablePath: "/usr/bin/chromium" };
    expect(config.executablePath).toBe("/usr/bin/chromium");
  });

  it("createEngineAdapter returns an EngineAdapter", () => {
    const adapter = createEngineAdapter();
    expect(typeof adapter.launch).toBe("function");
    expect(typeof adapter.createContext).toBe("function");
    expect(typeof adapter.shutdown).toBe("function");
  });

  it("launch() rejects on invalid executable path", async () => {
    const adapter = createEngineAdapter();
    await expect(
      adapter.launch({ headless: true, executablePath: "/nonexistent/browser" }),
    ).rejects.toThrow();
  });

  it("createContext() rejects when not launched", async () => {
    const adapter = createEngineAdapter();
    await expect(adapter.createContext()).rejects.toThrow("not launched");
  });

  it("detectChromiumExecutable returns string or undefined", () => {
    const result = detectChromiumExecutable();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("BrowserContextId is a branded string at runtime", () => {
    const id = "ctx-1" as unknown as BrowserContextId;
    expect(typeof id).toBe("string");
  });
});
