/**
 * S10 — Streamable HTTP transport: an external MCP client connects to the
 * self-hosted gateway over the network and lists/calls tools. This is the
 * Docker self-hosted entrypoint exercised in-process (no container).
 *
 * The connect + listTools path needs no browser, so it runs in CI everywhere.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createEngineAdapter, detectChromiumExecutable, type EngineAdapter } from "@lattice/engine";
import { createSecurityKernel } from "@lattice/kernel";
import { createAgentGateway, type GatewayServer } from "./index.js";

type MCPContent = { type: string; text: string };
function toolText(res: { [x: string]: unknown }): string {
  const content = (res as { content: unknown[] }).content;
  const item = content[0] as MCPContent | undefined;
  if (!item || item.type !== "text") throw new Error("Expected text content");
  return item.text;
}

function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  // SDK transport's onclose getter variance vs Transport under
  // exactOptionalPropertyTypes — benign; cast at the boundary.
  return client.connect(transport as unknown as Parameters<Client["connect"]>[0]).then(() => client);
}

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

// ── End-to-end over HTTP (browser-gated) ──────────────────────────────────────

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const FORM_HTML = `<!DOCTYPE html>
<html lang="en"><head><title>HTTP E2E</title></head>
<body>
<form id="f">
  <label for="username">Username</label>
  <input id="username" type="text" name="username">
  <button type="submit" id="go">Go</button>
</form>
</body></html>`;

function startFixture(html: string): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("bad address")); return; }
      resolve({ url: `http://127.0.0.1:${addr.port}/`, server });
    });
  });
}

describeIfBrowser("Gateway — external agent end-to-end over HTTP (S10)", () => {
  let engine: EngineAdapter;
  let gateway: GatewayServer;
  let mcpUrl: string;
  let fixtureUrl: string;
  let fixture: Server;

  beforeAll(async () => {
    engine = createEngineAdapter();
    await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const kernel = createSecurityKernel({
      allowedOrigins: ["http://127.0.0.1"],
      egressAllowlist: [],
      prohibitedActions: [],
    });
    gateway = createAgentGateway({ engine, kernel });
    mcpUrl = (await gateway.startHttp(0, "127.0.0.1")).url;
    const f = await startFixture(FORM_HTML);
    fixtureUrl = f.url;
    fixture = f.server;
  });

  afterAll(async () => {
    await gateway.stop();
    await engine.shutdown();
    fixture?.close();
  });

  it("drives a full perceive→act→extract cycle over the network", async () => {
    const client = await connectClient(mcpUrl);
    try {
      const { sessionId } = JSON.parse(
        toolText(await client.callTool({ name: "session.create", arguments: {} })),
      ) as { sessionId: string };
      expect(typeof sessionId).toBe("string");

      await client.callTool({
        name: "act.execute",
        arguments: { sessionId, command: { type: "navigate", url: fixtureUrl } },
      });

      const snap = JSON.parse(toolText(await client.callTool({
        name: "perceive.snapshot",
        arguments: { sessionId, tier: "L1" },
      }))) as { tier: string; nodeCount: number; nodes: Array<{ id: string; label: string }> };
      expect(snap.tier).toBe("L1");
      expect(snap.nodeCount).toBeGreaterThan(0);

      const usernameNode = snap.nodes.find((n) => n.label?.toLowerCase().includes("username"));
      expect(usernameNode).toBeDefined();

      await client.callTool({
        name: "act.execute",
        arguments: { sessionId, command: { type: "fill", target: { nodeId: usernameNode!.id }, value: "alice" } },
      });

      const extracted = JSON.parse(toolText(await client.callTool({
        name: "extract.query",
        arguments: { sessionId, query: "value:#username" },
      }))) as { result: string };
      expect(extracted.result).toBe("alice");

      const destroyed = JSON.parse(toolText(await client.callTool({
        name: "session.destroy",
        arguments: { sessionId },
      }))) as Record<string, unknown>;
      expect(destroyed).toMatchObject({ destroyed: true });
    } finally {
      await client.close();
    }
  });
});
