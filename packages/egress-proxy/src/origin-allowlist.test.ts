import { describe, it, expect } from "vitest";
import { originAllowlist } from "./index.js";

describe("originAllowlist — same-site subdomain relaxation (#5)", () => {
  const TASK = ["https://vuejs.org"];

  it("origin-exact by default: a subdomain is BLOCKED", () => {
    const allow = originAllowlist(TASK, []);
    expect(allow("https://vuejs.org")).toBe(true);
    expect(allow("https://automation.vuejs.org")).toBe(false);
  });

  it("allowSubdomains: permits subdomains of an allowed host", () => {
    const allow = originAllowlist(TASK, [], { allowSubdomains: true });
    expect(allow("https://vuejs.org")).toBe(true);
    expect(allow("https://automation.vuejs.org")).toBe(true);
    expect(allow("https://www.vuejs.org")).toBe(true);
  });

  it("allowSubdomains NEVER crosses to a different registrable domain", () => {
    const allow = originAllowlist(TASK, [], { allowSubdomains: true });
    expect(allow("https://evil.com")).toBe(false);
    // a look-alike that merely ENDS with the string but isn't a real subdomain
    expect(allow("https://notvuejs.org")).toBe(false);
    expect(allow("https://vuejs.org.evil.com")).toBe(false);
  });

  it("allowSubdomains does not broaden across schemes", () => {
    const allow = originAllowlist(TASK, [], { allowSubdomains: true });
    expect(allow("http://automation.vuejs.org")).toBe(false);
  });

  it("does not broaden to the PARENT of an allowed subdomain", () => {
    const allow = originAllowlist(["https://www.example.com"], [], { allowSubdomains: true });
    expect(allow("https://example.com")).toBe(false);
  });
});
