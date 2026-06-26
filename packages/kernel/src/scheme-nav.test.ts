import { describe, it, expect } from "vitest";
import { createSecurityKernel } from "./index.js";

// Audit: the navigate gate must block file:// even under percent/unicode obfuscation.
describe("checkNavigation — scheme canonicalization on the navigate gate", () => {
  const k = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
  it("blocks plain and obfuscated file:// (empty allowlist = unrestricted dev)", () => {
    expect(k.checkNavigation("file:///etc/passwd")).toBe(false);
    expect(k.checkNavigation("fi%6ce:///etc/passwd")).toBe(false);
    expect(k.checkNavigation("file%3a///etc/passwd")).toBe(false);
    expect(k.checkNavigation("ｊａｖａscript:alert(1)")).toBe(false);
  });
  it("allows ordinary http(s) navigation in unrestricted dev", () => {
    expect(k.checkNavigation("https://example.com")).toBe(true);
  });
});
