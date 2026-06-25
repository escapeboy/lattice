import { describe, it, expect } from "vitest";
import { createClient } from "./index.js";
import type { LatticeClientConfig } from "./index.js";

describe("@lattice/sdk-ts scaffold", () => {
  it("LatticeClientConfig accepts stdio endpoint", () => {
    const config: LatticeClientConfig = { endpoint: "stdio" };
    expect(config.endpoint).toBe("stdio");
  });

  it("LatticeClientConfig accepts http endpoint with token", () => {
    const config: LatticeClientConfig = { endpoint: "http://localhost:3000", token: "tok-abc" };
    expect(config.token).toBe("tok-abc");
  });

  it("createClient throws NotImplemented until S6", () => {
    expect(() => createClient({ endpoint: "stdio" })).toThrow("Not implemented");
  });
});
