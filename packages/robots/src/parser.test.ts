import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed, selectGroup, patternToRegExp } from "./parser.js";

describe("patternToRegExp", () => {
  it("matches a literal prefix", () => {
    expect(patternToRegExp("/admin").test("/admin/users")).toBe(true);
    expect(patternToRegExp("/admin").test("/public")).toBe(false);
  });
  it("treats * as any sequence", () => {
    expect(patternToRegExp("/*.php").test("/index.php")).toBe(true);
    expect(patternToRegExp("/*.php").test("/a/b/c.php")).toBe(true);
    expect(patternToRegExp("/*.php").test("/index.html")).toBe(false);
  });
  it("anchors a trailing $", () => {
    expect(patternToRegExp("/page$").test("/page")).toBe(true);
    expect(patternToRegExp("/page$").test("/page/sub")).toBe(false);
  });
  it("escapes regex metacharacters in the literal parts", () => {
    expect(patternToRegExp("/a.b+c").test("/a.b+c")).toBe(true);
    expect(patternToRegExp("/a.b+c").test("/axbxc")).toBe(false);
  });
});

describe("parseRobots + isAllowed", () => {
  it("default-allows when there is no matching group", () => {
    const r = parseRobots("User-agent: SomeoneElse\nDisallow: /");
    expect(isAllowed(r, "Lattice", "/anything")).toBe(true);
  });

  it("applies the * group when no specific token matches", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private");
    expect(isAllowed(r, "Lattice", "/private/x")).toBe(false);
    expect(isAllowed(r, "Lattice", "/public")).toBe(true);
  });

  it("prefers the most specific matching group over *", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: Lattice\nAllow: /ok\nDisallow: /",
    );
    // Lattice group wins over *; /ok allowed, everything else disallowed.
    expect(isAllowed(r, "Lattice", "/ok/page")).toBe(true);
    expect(isAllowed(r, "Lattice", "/nope")).toBe(false);
  });

  it("empty Disallow imposes nothing (allow all)", () => {
    const r = parseRobots("User-agent: *\nDisallow:");
    expect(isAllowed(r, "Lattice", "/anything")).toBe(true);
  });

  it("Disallow: / blocks everything", () => {
    const r = parseRobots("User-agent: *\nDisallow: /");
    expect(isAllowed(r, "Lattice", "/")).toBe(false);
    expect(isAllowed(r, "Lattice", "/x")).toBe(false);
  });

  it("longest-match wins; Allow beats Disallow on a tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b");
    expect(isAllowed(r, "Lattice", "/a/x")).toBe(false); // only /a matches
    expect(isAllowed(r, "Lattice", "/a/b/c")).toBe(true); // /a/b is longer
    const tie = parseRobots("User-agent: *\nDisallow: /p\nAllow: /p");
    expect(isAllowed(tie, "Lattice", "/p")).toBe(true); // tie → Allow wins
  });

  it("matches the token case-insensitively as a substring", () => {
    const r = parseRobots("User-agent: lattice\nDisallow: /x");
    expect(isAllowed(r, "Lattice/1.0", "/x")).toBe(false);
    expect(selectGroup(r, "Lattice/1.0")?.agents).toEqual(["lattice"]);
  });

  it("ignores comments, blank lines, BOM and unknown fields", () => {
    const r = parseRobots("﻿# comment\nSitemap: https://x/s.xml\nUser-agent: *  # ua\nCrawl-delay: 5\nDisallow: /q\n");
    expect(isAllowed(r, "Lattice", "/q")).toBe(false);
    expect(isAllowed(r, "Lattice", "/other")).toBe(true);
  });

  it("matches against path + query", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*?sort=");
    expect(isAllowed(r, "Lattice", "/list?sort=asc")).toBe(false);
    expect(isAllowed(r, "Lattice", "/list")).toBe(true);
  });

  it("a rule before any User-agent line is ignored", () => {
    const r = parseRobots("Disallow: /\nUser-agent: *\nAllow: /");
    expect(isAllowed(r, "Lattice", "/anything")).toBe(true);
  });
});
