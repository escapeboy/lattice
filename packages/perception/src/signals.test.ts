import { describe, it, expect } from "vitest";
import { pageSignals } from "./signals.js";

const many = Array.from({ length: 20 }, (_, i) => ({ label: `Item ${i}` }));

describe("pageSignals (#2)", () => {
  it("returns undefined for a normal content-rich page", () => {
    expect(pageSignals(many, "Dashboard")).toBeUndefined();
  });

  it("flags content-sparse pages (≤2 addressable nodes) — canvas/bot-wall/error", () => {
    const s = pageSignals([{ label: "Loading" }], "App");
    expect(s?.contentSparse).toBe(true);
    expect(s?.hint).toMatch(/L3|dead page|canvas/i);
  });

  it("flags error / bot-wall text with high precision (even if not sparse)", () => {
    const s = pageSignals(many, "Access Denied — verify you are human");
    expect(s?.looksLikeError).toBe(true);
    expect(s?.hint).toMatch(/error|bot-wall|handoff/i);
  });

  it("detects 404 / captcha in node labels too", () => {
    expect(pageSignals([{ label: "404 Not Found" }], "")?.looksLikeError).toBe(true);
    expect(pageSignals(many, "Please complete the captcha")?.looksLikeError).toBe(true);
  });

  it("does not false-positive on normal error-adjacent words", () => {
    expect(pageSignals(many, "Error handling guide — best practices")).toBeUndefined();
  });
});
