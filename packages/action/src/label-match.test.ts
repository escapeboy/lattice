import { describe, it, expect } from "vitest";
import { normalizeLabel, labelMatches } from "./label-match.js";

describe("normalizeLabel", () => {
  it("case-folds, trims, collapses whitespace", () => {
    expect(normalizeLabel("  LOG   IN ")).toBe("log in");
  });
  it("strips trailing decorative glyphs", () => {
    expect(normalizeLabel("Get Started →")).toBe("get started");
    expect(normalizeLabel("Next »")).toBe("next");
    expect(normalizeLabel("More…")).toBe("more");
  });
  it("strips leading decorative glyphs", () => {
    expect(normalizeLabel("→ Continue")).toBe("continue");
  });
  it("keeps internal punctuation", () => {
    expect(normalizeLabel("Log in / Sign up")).toBe("log in / sign up");
  });
});

describe("labelMatches", () => {
  it("matches exactly after normalisation (glyph + case)", () => {
    expect(labelMatches("Get Started →", "Get Started")).toBe(true);
    expect(labelMatches("LOG IN", "Log in")).toBe(true);
  });
  it("matches when the node carries extra trailing words", () => {
    expect(labelMatches("Reject all and subscribe", "Reject all")).toBe(true);
  });
  it("does NOT match the reverse (target longer than node) — avoids 'Log' capturing 'Log in'", () => {
    expect(labelMatches("Log", "Log in")).toBe(false);
  });
  it("does not match unrelated labels", () => {
    expect(labelMatches("Cancel", "Submit")).toBe(false);
  });
  it("empty target never matches", () => {
    expect(labelMatches("Anything", "")).toBe(false);
  });
});
