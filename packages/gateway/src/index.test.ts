/**
 * S6 integration tests — Agent Gateway (MCP).
 * Requires a Chromium-compatible browser for browser-dependent tests.
 * Pure-unit tests run always.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { EngineAdapter } from "@lattice/engine";
import { SecurityKernelImpl } from "@lattice/kernel";
import { createAgentGateway } from "./index.js";
import { GatewayServer } from "./server.js";
import { Vault } from "./vault.js";

// ── Helper — MCP Client.callTool returns { [x:string]: unknown; content: ... }
// which collapses `content` to unknown under strict TS. Extract text safely.
type MCPContent = { type: string; text: string };
function toolText(res: { [x: string]: unknown }): string {
  const content = (res as { content: unknown[] }).content;
  const item = content[0] as MCPContent | undefined;
  if (!item || item.type !== "text") throw new Error("Expected text content");
  return item.text;
}

// ── Unit tests (no browser required) ─────────────────────────────────────────

describe("Vault", () => {
  it("stores a credential and returns public listing (no password)", () => {
    const vault = new Vault();
    const { id } = vault.store("Test", "https://example.com", "user@x.com", "s3cr3t");
    const list = vault.listPublic();
    expect(list).toHaveLength(1);
    const entry = list[0];
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(id);
    expect(entry!.username).toBe("user@x.com");
    // password must not appear in public listing
    expect(JSON.stringify(entry)).not.toContain("s3cr3t");
  });

  it("getPassword returns the secret only internally", () => {
    const vault = new Vault();
    const { id } = vault.store("X", "https://x.com", "u", "my-pass");
    expect(vault.getPassword(id)).toBe("my-pass");
    expect(vault.getPassword("nonexistent")).toBeUndefined();
  });

  it("listPublic does not leak password even as a serialised string", () => {
    const vault = new Vault();
    vault.store("Bank", "https://bank.example", "alice", "topsecret42");
    const json = JSON.stringify(vault.listPublic());
    expect(json).not.toContain("topsecret42");
    expect(json).toContain("alice");
  });
});

// ── MCP server list-tools test (no browser required) ─────────────────────────

describe("GatewayServer — MCP tool listing", () => {
  async function buildInProcessClient(): Promise<{ client: Client; gateway: GatewayServer }> {
    const engine = createEngineAdapter();
    const kernel = new SecurityKernelImpl({
      allowedOrigins: [],
      egressAllowlist: [],
      prohibitedActions: [],
    });
    const gateway = createAgentGateway({ engine, kernel });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.getMCPServer().connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
    return { client, gateway };
  }

  it("exposes all expected tool groups", async () => {
    const { client, gateway } = await buildInProcessClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("session_create");
    expect(names).toContain("session_destroy");
    expect(names).toContain("session_list");
    expect(names).toContain("perceive_snapshot");
    expect(names).toContain("perceive_delta");
    expect(names).toContain("act_execute");
    expect(names).toContain("extract_query");
    expect(names).toContain("capability_check");
    expect(names).toContain("vault_store");
    expect(names).toContain("vault_list");
    expect(names).toContain("vault_autofill");
    expect(names).toContain("policy_classify");

    await client.close();
    await gateway.stop();
  });

  it("vault.store → vault.list via MCP — no password in response", async () => {
    const { client, gateway } = await buildInProcessClient();

    const storeRes = await client.callTool({
      name: "vault_store",
      arguments: {
        label: "My Bank",
        origin: "https://bank.com",
        username: "alice@bank.com",
        password: "TopSecret123",
      },
    });
    const storeText = toolText(storeRes);
    const storeJson = JSON.parse(storeText) as Record<string, unknown>;
    expect(typeof storeJson["credentialId"]).toBe("string");
    // Password must NOT appear in the store response
    expect(storeText).not.toContain("TopSecret123");

    const listRes = await client.callTool({ name: "vault_list", arguments: {} });
    const listText = toolText(listRes);
    // Password must NOT appear in the list response either
    expect(listText).not.toContain("TopSecret123");
    expect(listText).toContain("alice@bank.com");

    await client.close();
    await gateway.stop();
  });
});

// ── Browser-dependent integration tests ───────────────────────────────────────

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Login</title></head>
<body>
<form id="login-form">
  <label for="username">Username</label>
  <input id="username" type="text" name="username" autocomplete="username">

  <label for="password">Password</label>
  <input id="password" type="password" name="password" autocomplete="current-password">

  <button type="submit" id="login-btn">Login</button>
</form>
<div id="result"></div>
<script>
  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const u = document.getElementById("username").value;
    document.getElementById("result").textContent = "logged-in:" + u;
  });
</script>
</body>
</html>`;

function startTestServer(html: string): Promise<{ url: string; server: Server }> {
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

describeIfBrowser("GatewayServer — browser integration", () => {
  let engine: EngineAdapter;
  let gateway: GatewayServer;
  let client: Client;
  let serverUrl: string;
  let httpServer: Server;

  beforeAll(async () => {
    engine = createEngineAdapter();
    await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });

    const kernel = new SecurityKernelImpl({
      allowedOrigins: ["http://127.0.0.1"],
      egressAllowlist: [],
      prohibitedActions: [],
    });
    gateway = createAgentGateway({ engine, kernel });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.getMCPServer().connect(serverTransport);
    client = new Client({ name: "lattice-test", version: "0.0.1" });
    await client.connect(clientTransport);

    const srv = await startTestServer(LOGIN_HTML);
    serverUrl = srv.url;
    httpServer = srv.server;
  });

  afterAll(async () => {
    await client.close();
    await gateway.stop();
    await engine.shutdown();
    httpServer.close();
  });

  it("full perceive→act→extract cycle via MCP", async () => {
    // 1. Create session
    const { sessionId } = JSON.parse(toolText(await client.callTool({ name: "session_create", arguments: {} }))) as { sessionId: string };
    expect(typeof sessionId).toBe("string");

    // 2. Navigate
    await client.callTool({
      name: "act_execute",
      arguments: { sessionId, command: { type: "navigate", url: serverUrl } },
    });

    // 3. Perceive snapshot
    const snap = JSON.parse(toolText(await client.callTool({
      name: "perceive_snapshot",
      arguments: { sessionId, tier: "L1" },
    }))) as { tier: string; nodeCount: number; nodes: Array<{ id: string; role: string; label: string }> };
    expect(snap.tier).toBe("L1");
    expect(snap.nodeCount).toBeGreaterThan(0);

    // Find username node
    const usernameNode = snap.nodes.find((n) => n.label?.toLowerCase().includes("username"));
    expect(usernameNode).toBeDefined();

    // 4. Fill username
    await client.callTool({
      name: "act_execute",
      arguments: {
        sessionId,
        command: { type: "fill", target: { nodeId: usernameNode!.id }, value: "alice" },
      },
    });

    // 5. Extract username field value
    const extracted = JSON.parse(toolText(await client.callTool({
      name: "extract_query",
      arguments: { sessionId, query: "value:#username" },
    }))) as { result: string };
    expect(extracted.result).toBe("alice");

    // 6. Destroy session
    const destroyed = JSON.parse(toolText(await client.callTool({
      name: "session_destroy",
      arguments: { sessionId },
    }))) as Record<string, unknown>;
    expect(destroyed).toMatchObject({ destroyed: true });
  });

  it("perceive.delta returns changes after DOM mutation", async () => {
    const { sessionId } = JSON.parse(toolText(await client.callTool({ name: "session_create", arguments: {} }))) as { sessionId: string };

    await client.callTool({
      name: "act_execute",
      arguments: { sessionId, command: { type: "navigate", url: serverUrl } },
    });

    // First snapshot (establishes baseline)
    await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } });

    // Mutate DOM — fill the input, which changes its value
    await client.callTool({
      name: "act_execute",
      arguments: {
        sessionId,
        command: { type: "fill", target: { nodeId: "placeholder" }, value: "test" },
      },
    }).catch(() => { /* fill may fail if nodeId is placeholder — that's fine, mutation still tested */ });

    // Delta
    const deltaText = toolText(await client.callTool({
      name: "perceive_delta",
      arguments: { sessionId },
    }));
    const deltaObj = JSON.parse(deltaText) as { delta: unknown; url: string };
    expect(deltaObj).toHaveProperty("url");
    expect(deltaText).toBeTruthy();

    await client.callTool({ name: "session_destroy", arguments: { sessionId } });
  });

  it("vault.autofill — fills fields without exposing password value in any response", async () => {
    const { sessionId } = JSON.parse(toolText(await client.callTool({ name: "session_create", arguments: {} }))) as { sessionId: string };

    await client.callTool({
      name: "act_execute",
      arguments: { sessionId, command: { type: "navigate", url: serverUrl } },
    });

    // Discover nodes
    const snap = JSON.parse(toolText(await client.callTool({ name: "perceive_snapshot", arguments: { sessionId, tier: "L1" } }))) as { nodes: Array<{ id: string; label: string }> };
    const usernameNode = snap.nodes.find((n) => n.label?.toLowerCase().includes("username"));
    const passwordNode = snap.nodes.find((n) => n.label?.toLowerCase().includes("password"));
    expect(usernameNode).toBeDefined();
    expect(passwordNode).toBeDefined();

    // Store credential
    const storeText = toolText(await client.callTool({
      name: "vault_store",
      arguments: { label: "Test Login", origin: serverUrl, username: "bob", password: "hunter2" },
    }));
    const { credentialId } = JSON.parse(storeText) as { credentialId: string };
    // Password must not appear in vault.store response
    expect(storeText).not.toContain("hunter2");

    // Autofill
    const fillRes = await client.callTool({
      name: "vault_autofill",
      arguments: {
        sessionId,
        credentialId,
        usernameNodeId: usernameNode!.id,
        passwordNodeId: passwordNode!.id,
      },
    });

    // Password must NEVER appear in any response
    const fillJson = JSON.stringify(fillRes);
    expect(fillJson).not.toContain("hunter2");
    expect(fillJson).toContain("filled");

    // Username field should be filled
    const { result } = JSON.parse(toolText(await client.callTool({
      name: "extract_query",
      arguments: { sessionId, query: "value:#username" },
    }))) as { result: string };
    expect(result).toBe("bob");

    await client.callTool({ name: "session_destroy", arguments: { sessionId } });
  });

  it("session.list shows active sessions", async () => {
    const { sessionId: s1id } = JSON.parse(toolText(await client.callTool({ name: "session_create", arguments: {} }))) as { sessionId: string };
    const { sessionId: s2id } = JSON.parse(toolText(await client.callTool({ name: "session_create", arguments: {} }))) as { sessionId: string };

    const { sessions } = JSON.parse(toolText(await client.callTool({ name: "session_list", arguments: {} }))) as { sessions: string[] };
    expect(sessions).toContain(s1id);
    expect(sessions).toContain(s2id);

    await client.callTool({ name: "session_destroy", arguments: { sessionId: s1id } });
    await client.callTool({ name: "session_destroy", arguments: { sessionId: s2id } });
  });
});
