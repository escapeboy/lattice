import { describe, it, expect } from "vitest";
import { ActionError, createActionEngine } from "./index.js";
import type { ActionCommand, ActionErrorCode } from "./index.js";

describe("@lattice/action scaffold", () => {
  it("ActionCommand navigate is typed", () => {
    const cmd: ActionCommand = { type: "navigate", url: "https://example.com" };
    expect(cmd.type).toBe("navigate");
  });

  it("ActionError carries code + message", () => {
    const code: ActionErrorCode = "element_gone";
    const err = new ActionError(code, "re-perceive root");
    expect(err.code).toBe("element_gone");
    expect(err.rePerceptionHint).toBe("re-perceive root");
    expect(err instanceof Error).toBe(true);
  });

  it("createActionEngine throws NotImplemented until S3", () => {
    expect(() => createActionEngine()).toThrow("Not implemented");
  });
});
