import { describe, it, expect } from "vitest";
import { ActionError, createActionEngine } from "./index.js";
import type { ActionCommand, ActionErrorCode } from "./index.js";

describe("@lattice/action — types", () => {
  it("ActionCommand navigate is typed", () => {
    const cmd: ActionCommand = { type: "navigate", url: "https://example.com" };
    expect(cmd.type).toBe("navigate");
  });

  it("ActionCommand fill carries target + value", () => {
    const cmd: ActionCommand = {
      type: "fill",
      target: { nodeId: "input-abc123" as never },
      value: "hello",
    };
    expect(cmd.type).toBe("fill");
    if (cmd.type === "fill") expect(cmd.value).toBe("hello");
  });

  it("ActionError carries code + message", () => {
    const code: ActionErrorCode = "element_gone";
    const err = new ActionError(code, "re-perceive root");
    expect(err.code).toBe("element_gone");
    expect(err.rePerceptionHint).toBe("re-perceive root");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("ActionError");
  });

  it("ActionError is distinguishable from generic Error", () => {
    const err = new ActionError("disabled");
    expect(err instanceof ActionError).toBe(true);
    expect(err.code).toBe("disabled");
  });

  it("createActionEngine returns ActionEngine interface", () => {
    const engine = createActionEngine(null as never, null as never, null as never);
    expect(typeof engine.execute).toBe("function");
  });
});
