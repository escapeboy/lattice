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

      expect(names).toContain("session_create");
      expect(names).toContain("perceive_snapshot");
      expect(names).toContain("act_execute");
      expect(names).toContain("extract_query");
      expect(names).toContain("vault_autofill");
    } finally {
      await client.close();
    }
  });

  it("rejects unknown paths with 404", async () => {
    const res = await fetch(mcpUrl.replace("/mcp", "/nope"));
    expect(res.status).toBe(404);
  });

  it("A2: when an mcpToken is set, /mcp requires the bearer token (PII surface not open)", async () => {
    const engine = createEngineAdapter();
    const kernel = createSecurityKernel({ allowedOrigins: [], egressAllowlist: [], prohibitedActions: [] });
    const guarded = createAgentGateway({ engine, kernel, mcpToken: "s3cr3t" });
    const { url } = await guarded.startHttp(0, "127.0.0.1");
    try {
      const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
      // No token → 401.
      const noAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
      expect(noAuth.status).toBe(401);
      // Wrong token → 401.
      const badAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer nope" }, body: JSON.stringify(init) });
      expect(badAuth.status).toBe(401);
      // /health stays open (no token needed).
      const health = await fetch(url.replace("/mcp", "/health"));
      expect(health.status).toBe(200);
    } finally {
      await guarded.stop();
    }
  });

  it("supports multiple concurrent MCP sessions (transport pool)", async () => {
    // Two independent agents connect at the same time — the old single-session
    // transport would reject the second initialize with a 400.
    const a = await connectClient(mcpUrl);
    const b = await connectClient(mcpUrl);
    try {
      const [ta, tb] = await Promise.all([a.listTools(), b.listTools()]);
      expect(ta.tools.length).toBeGreaterThan(0);
      expect(tb.tools.length).toBe(ta.tools.length);

      // /health reports two live sessions.
      const health = await (await fetch(mcpUrl.replace("/mcp", "/health"))).json() as { sessions: number };
      expect(health.sessions).toBeGreaterThanOrEqual(2);

      // Closing one leaves the other usable.
      await a.close();
      const stillWorks = await b.listTools();
      expect(stillWorks.tools.length).toBe(tb.tools.length);
    } finally {
      await b.close();
    }
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
      allowedOrigins: [] /* unrestricted: dynamic ports */,
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
        toolText(await client.callTool({ name: "session_create", arguments: {} })),
      ) as { sessionId: string };
      expect(typeof sessionId).toBe("string");

      await client.callTool({
        name: "act_execute",
        arguments: { sessionId, command: { type: "navigate", url: fixtureUrl } },
      });

      const snap = JSON.parse(toolText(await client.callTool({
        name: "perceive_snapshot",
        arguments: { sessionId, tier: "L1" },
      }))) as { tier: string; nodeCount: number; nodes: Array<{ id: string; label: string }> };
      expect(snap.tier).toBe("L1");
      expect(snap.nodeCount).toBeGreaterThan(0);

      const usernameNode = snap.nodes.find((n) => n.label?.toLowerCase().includes("username"));
      expect(usernameNode).toBeDefined();

      await client.callTool({
        name: "act_execute",
        arguments: { sessionId, command: { type: "fill", target: { nodeId: usernameNode!.id }, value: "alice" } },
      });

      const extracted = JSON.parse(toolText(await client.callTool({
        name: "extract_query",
        arguments: { sessionId, query: "value:#username" },
      }))) as { result: string };
      expect(extracted.result).toBe("alice");

      const destroyed = JSON.parse(toolText(await client.callTool({
        name: "session_destroy",
        arguments: { sessionId },
      }))) as Record<string, unknown>;
      expect(destroyed).toMatchObject({ destroyed: true });
    } finally {
      await client.close();
    }
  });
});
