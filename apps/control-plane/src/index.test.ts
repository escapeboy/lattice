import { describe, it, expect } from "vitest";
import { createControlPlane } from "./index.js";
import type { ControlPlaneConfig } from "./index.js";

describe("@lattice/control-plane scaffold", () => {
  it("ControlPlaneConfig accepts desktop mode", () => {
    const config: ControlPlaneConfig = { mode: "desktop", gatewayEndpoint: "stdio" };
    expect(config.mode).toBe("desktop");
  });

  it("ControlPlaneConfig accepts web mode", () => {
    const config: ControlPlaneConfig = {
      mode: "web",
      gatewayEndpoint: "http://localhost:3000",
    };
    expect(config.gatewayEndpoint).toContain("localhost");
  });

  it("createControlPlane throws NotImplemented until S8", () => {
    expect(() => createControlPlane()).toThrow("Not implemented");
  });
});
