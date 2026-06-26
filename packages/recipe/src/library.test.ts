import { describe, it, expect } from "vitest";
import { RecipeLibrary } from "./library.js";
import type { RecipeDef } from "./types.js";

const ORIGIN = "https://app.example.com";

function def(over: Partial<RecipeDef> = {}): RecipeDef {
  return {
    id: "login",
    origin: ORIGIN,
    name: "Log in",
    trust: "trusted",
    steps: [
      { action: "fill", locator: { role: "input", label: "Email" }, value: "a@b.com" },
      { action: "submit", locator: { role: "button", label: "Sign in" } },
    ],
    ...over,
  };
}

describe("RecipeLibrary — define / version / get / list", () => {
  it("assigns monotonic versions per (origin, id)", () => {
    const lib = new RecipeLibrary();
    const v1 = lib.define(def());
    const v2 = lib.define(def());
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(lib.versions(ORIGIN, "login")).toEqual([1, 2]);
  });

  it("get returns the latest by default and a specific version on request", () => {
    const lib = new RecipeLibrary();
    lib.define(def({ name: "v1" }));
    lib.define(def({ name: "v2" }));
    expect(lib.get(ORIGIN, "login")?.name).toBe("v2");
    expect(lib.get(ORIGIN, "login", 1)?.name).toBe("v1");
    expect(lib.get(ORIGIN, "login", 99)).toBeUndefined();
    expect(lib.get(ORIGIN, "missing")).toBeUndefined();
  });

  it("keeps every version so a trace can replay against the exact recipe that ran", () => {
    const lib = new RecipeLibrary();
    lib.define(def());
    lib.define(def());
    expect(lib.get(ORIGIN, "login", 1)).toBeDefined();
    expect(lib.get(ORIGIN, "login", 2)).toBeDefined();
  });

  it("rejects a non-increasing explicit version", () => {
    const lib = new RecipeLibrary();
    lib.define(def());
    lib.define(def());
    expect(() => lib.define(def({ version: 1 }))).toThrow(/not > latest/);
  });

  it("list returns the latest per (origin, id), filterable by origin", () => {
    const lib = new RecipeLibrary();
    lib.define(def());
    lib.define(def({ id: "checkout", name: "Checkout" }));
    lib.define(def({ origin: "https://other.example", id: "login", name: "Other login" }));
    expect(lib.list(ORIGIN).map((r) => r.id).sort()).toEqual(["checkout", "login"]);
    expect(lib.list("https://other.example").map((r) => r.id)).toEqual(["login"]);
    expect(lib.list()).toHaveLength(3);
  });

  it("marks provenance: an untrusted-source recipe is flagged so a policy can refuse auto-apply", () => {
    const lib = new RecipeLibrary();
    const r = lib.define(def({ trust: "untrusted" }));
    expect(r.trust).toBe("untrusted");
  });
});
