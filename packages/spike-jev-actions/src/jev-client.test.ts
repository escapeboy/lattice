import { describe, expect, it } from "vitest";
import { JevError, REDACTED, redactHeaders, validateChoice, costUsd } from "./jev-client.js";

const SECRET = "sk-live-do-not-log-me-0123456789";

describe("credential redaction", () => {
  it("redacts Authorization, x-api-key and Cookie", () => {
    const out = redactHeaders({
      Authorization: `Bearer ${SECRET}`,
      "x-api-key": SECRET,
      Cookie: `session=${SECRET}`,
      "Content-Type": "application/json",
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out["Authorization"]).toBe(REDACTED);
    expect(out["x-api-key"]).toBe(REDACTED);
    expect(out["Cookie"]).toBe(REDACTED);
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("never leaks the key through a thrown error's message or serialisation", () => {
    const err = new JevError(
      401,
      '{"error":"unauthorized"}',
      redactHeaders({ Authorization: `Bearer ${SECRET}` }),
    );
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err.requestHeaders)).not.toContain(SECRET);
    expect(`${err.stack}`).not.toContain(SECRET);
  });
});

describe("choice validation", () => {
  const options = ["CLICK", "WAIT", "other"];

  it("accepts a well-formed distribution", () => {
    const a = validateChoice(
      { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, WAIT: 0.05, other: 0.05 } },
      options,
    );
    expect(a.choice).toBe("CLICK");
  });

  it("rejects a choice outside the offered options", () => {
    expect(() =>
      validateChoice(
        { type: "choice", choice: "PURCHASE", confidence: 1, probabilities: { CLICK: 1, WAIT: 0, other: 0 } },
        options,
      ),
    ).toThrow();
  });

  it("rejects probabilities that do not sum to 1", () => {
    expect(() =>
      validateChoice(
        { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.5, WAIT: 0.1, other: 0.1 } },
        options,
      ),
    ).toThrow();
  });

  it("rejects a distribution missing an offered option", () => {
    expect(() =>
      validateChoice(
        { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 1 } },
        options,
      ),
    ).toThrow();
  });
});

describe("cost", () => {
  it("prices input tokens at $42 per billion", () => {
    expect(costUsd(1_000_000_000)).toBeCloseTo(42, 6);
    expect(costUsd(1_000)).toBeCloseTo(0.000042, 9);
  });
});
