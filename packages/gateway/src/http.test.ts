/**
 * S10 — Streamable HTTP transport: an external MCP client connects to the
 * self-hosted gateway over the network and lists/calls tools. This is the
 * Docker self-hosted entrypoint exercised in-process (no container).
 *
 * The connect + listTools path needs no browser, so it runs in CI everywhere.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createEngineAdapter } from "@lattice/engine";
import { createSecurityKernel } from "@lattice/kernel";
import { createAgentGateway, type GatewayServer } from "./index.js";

describe("Gateway — Streamable HTTP transport (S10)", () => {
  let gateway: GatewayServer;
  let mcpUrl: string;

  beforeAll(async () => {
    const engine = createEngineAdapter(); // not launched: listTools never touches it
    const kernel = createSecurityKernel({
      allowedOrigins: [],
      egressAllowlist: [],
      prohibitedActions: ["payment", "account.create"],
    });
    gateway = createAgentGateway({ engine, kernel });
    const { url } = await gateway.startHttp(0, "127.0.0.1");
    mcpUrl = url;
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("serves a /health endpoint", async () => {
    const healthUrl = mcpUrl.replace("/mcp", "/health");
    const res = await fetch(healthUrl);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; server: string };
    expect(body.status).toBe("ok");
    expect(body.server).toBe("lattice-gateway");
  });

  it("an external MCP client connects and lists the tool catalogue", async () => {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    // SDK transport's onclose getter variance vs Transport under
    // exactOptionalPropertyTypes — benign; cast at the boundary.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain("session.create");
      expect(names).toContain("perceive.snapshot");
      expect(names).toContain("act.execute");
      expect(names).toContain("extract.query");
      expect(names).toContain("vault.autofill");
    } finally {
      await client.close();
    }
  });

  it("rejects unknown paths with 404", async () => {
    const res = await fetch(mcpUrl.replace("/mcp", "/nope"));
    expect(res.status).toBe(404);
  });
});
