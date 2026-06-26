import { describe, it, expect } from "vitest";
import { forbiddenUrlScheme } from "./firewall.js";

// Audit (escape-hatch canonicalizer): the scheme check must defeat percent-
// encoding and unicode-confusable obfuscation, not just control/space chars.
describe("forbiddenUrlScheme — robust canonicalization", () => {
  it("blocks plain file:// (baseline)", () => {
    expect(forbiddenUrlScheme("file:///etc/passwd")).toBe("file");
  });
  it("blocks percent-encoded scheme chars (fi%6ce, %66ile)", () => {
    expect(forbiddenUrlScheme("fi%6ce:///etc/passwd")).toBe("file");
    expect(forbiddenUrlScheme("%66ile:///etc/passwd")).toBe("file");
  });
  it("blocks a percent-encoded colon (file%3a...)", () => {
    expect(forbiddenUrlScheme("file%3a///etc/passwd")).toBe("file");
  });
  it("blocks fullwidth / NFKC-confusable scheme (ｊａｖａscript)", () => {
    expect(forbiddenUrlScheme("ｊａｖａscript:alert(1)")).toBe("javascript");
  });
  it("leaves a normal http url alone", () => {
    expect(forbiddenUrlScheme("https://example.com/x")).toBeNull();
  });
});
