import { describe, it, expect } from "vitest";
import { createAgentGateway } from "./index.js";
import type { GatewayConfig } from "./index.js";

describe("@lattice/gateway scaffold", () => {
  it("GatewayConfig accepts stdio transport", () => {
    const config: GatewayConfig = { transport: "stdio" };
    expect(config.transport).toBe("stdio");
  });

  it("GatewayConfig accepts http-sse transport with port", () => {
    const config: GatewayConfig = { transport: "http-sse", port: 3000, host: "0.0.0.0" };
    expect(config.port).toBe(3000);
  });

  it("createAgentGateway throws NotImplemented until S6", () => {
    expect(() => createAgentGateway()).toThrow("Not implemented");
  });
});
