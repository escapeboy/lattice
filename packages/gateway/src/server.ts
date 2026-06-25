/**
 * Lattice Agent Gateway — MCP server (stdio + HTTP/SSE).
 *
 * Tool groups:
 *   session.*   — create/destroy/list contexts
 *   perceive.*  — L0-L2 snapshots, delta, subscribe
 *   act.*       — semantic action execution
 *   extract.*   — query page content
 *   capability.* — check page MCP support
 *   vault.*     — gated credential autofill (value never in response)
 *   policy.*    — read current policy classification
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { EngineAdapter } from "@lattice/engine";
import type { FidelityTier, InteractionGraph } from "@lattice/perception";
import type { SecurityKernel } from "@lattice/kernel";
import { SessionRegistry } from "./sessions.js";
import { Vault } from "./vault.js";

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "session_create",
    description: "Create an isolated browser session context",
    inputSchema: {
      type: "object" as const,
      properties: {
        topology: { type: "string", enum: ["ephemeral", "persistent"], default: "ephemeral" },
      },
    },
  },
  {
    name: "session_destroy",
    description: "Destroy a session and release all resources",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "session_list",
    description: "List active session IDs",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "perceive_snapshot",
    description: "Get Interaction Graph snapshot of the current page (L0=summary, L1=default IG, L2=with geometry, L3=IG + screenshot for canvas/invisible UI)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        tier: { type: "string", enum: ["L0", "L1", "L2", "L3"], default: "L1" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "perceive_delta",
    description: "Get delta (added/removed/updated nodes) since the last snapshot call on this session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "act_execute",
    description: "Execute a semantic action on the page (navigate/act/fill/select/submit/scroll_to/wait_for)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        command: {
          type: "object",
          properties: {
            type: { type: "string" },
            url: { type: "string" },
            target: { type: "object", properties: { nodeId: { type: "string" } } },
            value: { type: "string" },
            condition: { type: "object" },
            query: { type: "string" },
          },
          required: ["type"],
        },
      },
      required: ["sessionId", "command"],
    },
  },
  {
    name: "extract_query",
    description: "Extract data from the page. Prefix: text:<css>, attr:<css>@<attr>, value:<css>, or bare JS expression",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        query: { type: "string" },
      },
      required: ["sessionId", "query"],
    },
  },
  {
    name: "capability_check",
    description: "Check whether the current page exposes native MCP/WebMCP capabilities",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "vault_store",
    description: "Store a credential in the vault. Returns an ID — the secret value is never returned again.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string" },
        origin: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["label", "origin", "username", "password"],
    },
  },
  {
    name: "vault_list",
    description: "List stored credentials (id, label, origin, username — no passwords)",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "vault_autofill",
    description: "Fill username+password fields using a vault credential. The password value never appears in any response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        credentialId: { type: "string" },
        usernameNodeId: { type: "string" },
        passwordNodeId: { type: "string" },
      },
      required: ["sessionId", "credentialId", "usernameNodeId", "passwordNodeId"],
    },
  },
  {
    name: "policy_classify",
    description: "Classify an action type as read/benign/consequential/prohibited",
    inputSchema: {
      type: "object" as const,
      properties: {
        actionType: { type: "string" },
        origin: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["actionType"],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { chunks.push(c); });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : null));
    req.on("error", () => resolve(null));
  });
}

// ── GatewayServer ────────────────────────────────────────────────────────────

export class GatewayServer {
  private readonly mcp: Server;
  private readonly sessions: SessionRegistry;
  private readonly vault: Vault;
  private httpServer: HttpServer | null = null;
  private httpTransport: StreamableHTTPServerTransport | null = null;

  constructor(
    engine: EngineAdapter,
    kernel: SecurityKernel,
  ) {
    this.sessions = new SessionRegistry(engine, kernel);
    this.vault = new Vault();
    this.mcp = new Server(
      { name: "lattice-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: TOOLS }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a: Record<string, unknown> = args ?? {};

      try {
        return await this.dispatch(name, a);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    });
  }

  private async dispatch(
    name: string,
    a: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (name) {
      // ── session.* ──────────────────────────────────────────────────────────
      case "session_create": {
        const topology = (a["topology"] as "ephemeral" | "persistent" | undefined) ?? "ephemeral";
        const session = await this.sessions.create(topology);
        return ok({ sessionId: session.id, topology });
      }

      case "session_destroy": {
        await this.sessions.destroy(a["sessionId"] as string);
        return ok({ destroyed: true });
      }

      case "session_list": {
        return ok({ sessions: this.sessions.list() });
      }

      // ── perceive.* ─────────────────────────────────────────────────────────
      case "perceive_snapshot": {
        const session = this.getSession(a["sessionId"] as string);
        const tier = ((a["tier"] as string | undefined) ?? "L1") as FidelityTier;
        const snap = await session.perception.snapshot(tier);

        if (snap.tier === "L0") {
          session.recorder.recordSnapshot(tier, snap.url, snap.title ?? "", []);
          return ok(snap);
        }

        const ig: InteractionGraph = snap;
        const nodes = Array.from(ig.nodes.values());
        const prev = session.lastSnapshot;
        session.lastSnapshot = ig;

        session.recorder.recordSnapshot(ig.tier, ig.url, ig.title ?? "", nodes);
        if (prev) {
          const d = session.perception.delta(prev, ig);
          session.recorder.recordDelta(d.added.length, d.removed.length, d.updated.length, ig.url);
        }

        const payload = {
          tier: tier === "L3" ? "L3" : ig.tier,
          url: ig.url,
          title: ig.title,
          nodeCount: nodes.length,
          serializedSize: ig.serializedSize,
          nodes,
          ...(prev ? { delta: session.perception.delta(prev, ig) } : {}),
        };

        // L3 = pixel tier: ship the IG plus a screenshot so a vision-capable
        // agent can reason about canvas/WebGL UIs the AX tree can't represent.
        if (tier === "L3") {
          const data = await session.context.screenshot();
          return {
            content: [
              { type: "text", text: JSON.stringify(payload, null, 2) },
              { type: "image", data, mimeType: "image/png" },
            ],
          };
        }

        return ok(payload);
      }

      case "perceive_delta": {
        const session = this.getSession(a["sessionId"] as string);
        if (!session.lastSnapshot) return ok({ delta: null, reason: "no prior snapshot" });

        const current = (await session.perception.snapshot("L1")) as InteractionGraph;
        const delta = session.perception.delta(session.lastSnapshot, current);
        session.recorder.recordDelta(delta.added.length, delta.removed.length, delta.updated.length, current.url);
        session.lastSnapshot = current;
        return ok({ delta, url: current.url });
      }

      // ── act.* ──────────────────────────────────────────────────────────────
      case "act_execute": {
        const session = this.getSession(a["sessionId"] as string);
        const command = a["command"] as Parameters<typeof session.action.execute>[0];
        session.recorder.recordAction(command);
        try {
          const result = await session.action.execute(command);
          session.recorder.recordActionResult(result.success, result.url, result.extracted);
          return ok({
            success: result.success,
            url: result.url,
            delta: result.delta,
            ...(result.extracted !== undefined ? { extracted: result.extracted } : {}),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          session.recorder.recordActionResult(false, session.context.currentUrl(), undefined, msg);
          throw e;
        }
      }

      // ── extract.* ──────────────────────────────────────────────────────────
      case "extract_query": {
        const session = this.getSession(a["sessionId"] as string);
        const query = a["query"] as string;
        session.recorder.recordAction({ type: "extract", query });
        const result = await session.action.execute({ type: "extract", query });
        session.recorder.recordActionResult(result.success, result.url, result.extracted);
        return ok({ result: result.extracted });
      }

      // ── capability.* ───────────────────────────────────────────────────────
      case "capability_check": {
        const session = this.getSession(a["sessionId"] as string);
        const res = await session.context.cdp().send<{ result: { value: boolean } }>(
          "Runtime.evaluate",
          { expression: "typeof navigator.modelContext !== 'undefined'", returnByValue: true },
        ).catch(() => ({ result: { value: false } }));
        return ok({
          nativeMCP: res.result.value,
          url: session.context.currentUrl(),
        });
      }

      // ── vault.* ────────────────────────────────────────────────────────────
      case "vault_store": {
        const result = this.vault.store(
          a["label"] as string,
          a["origin"] as string,
          a["username"] as string,
          a["password"] as string,
        );
        return ok({ credentialId: result.id, note: "password stored — never returned via API" });
      }

      case "vault_list": {
        return ok({ credentials: this.vault.listPublic() });
      }

      case "vault_autofill": {
        const session = this.getSession(a["sessionId"] as string);
        const credId = a["credentialId"] as string;

        const username = this.vault.getUsername(credId);
        const password = this.vault.getPassword(credId);
        if (username === undefined || password === undefined) {
          return err(`Credential ${credId} not found`);
        }

        // Fill username field
        await session.action.execute({
          type: "fill",
          target: { nodeId: a["usernameNodeId"] as never },
          value: username,
        });

        // Fill password field — value flows engine→form, never in response
        await session.action.execute({
          type: "fill",
          target: { nodeId: a["passwordNodeId"] as never },
          value: password,
        });

        return ok({
          filled: true,
          fieldsWritten: ["username", "password"],
          note: "credential values were written directly to the page — not included in this response",
        });
      }

      // ── policy.* ───────────────────────────────────────────────────────────
      case "policy_classify": {
        // Gateway doesn't hold kernel reference directly; return a static read
        return ok({
          actionType: a["actionType"],
          classification: "see kernel.classify() in @lattice/kernel",
        });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  }

  private getSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  /**
   * Start a network-listening MCP server over Streamable HTTP (the self-hosted
   * Docker entrypoint). Stateless JSON mode: MCP transport carries no session;
   * browser sessions are application-level (session.create returns a sessionId
   * the client threads through perceive/act). Endpoint: POST/GET/DELETE /mcp.
   */
  async startHttp(port = 8765, host = "0.0.0.0"): Promise<{ url: string }> {
    // Stateful single-session transport: the SDK assigns an mcp-session-id on
    // initialize and the client threads it through subsequent requests. Browser
    // sessions remain application-level (session.create → sessionId in tool args).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    // SDK's StreamableHTTPServerTransport declares onclose getter as `() => void
    // | undefined`, which is structurally incompatible with Transport under
    // exactOptionalPropertyTypes — a benign variance quirk; cast at the boundary.
    await this.mcp.connect(transport as unknown as Parameters<Server["connect"]>[0]);
    this.httpTransport = transport;

    const server = createServer((req, res) => {
      this.handleHttp(req, res, transport).catch((e: unknown) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
    this.httpServer = server;

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") { reject(new Error("bad address")); return; }
        resolve({ url: `http://${host}:${addr.port}/mcp` });
      });
    });
  }

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    transport: StreamableHTTPServerTransport,
  ): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "lattice-gateway", version: "0.1.0" }));
      return;
    }

    if (path !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. MCP endpoint is /mcp" }));
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    // GET (SSE stream) and DELETE (session teardown) are handled by the transport.
    await transport.handleRequest(req, res);
  }

  async stop(): Promise<void> {
    await this.sessions.destroyAll();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    if (this.httpTransport) {
      await this.httpTransport.close();
      this.httpTransport = null;
    }
    await this.mcp.close();
  }

  /** Expose underlying MCP server for transport injection in tests. */
  getMCPServer(): Server {
    return this.mcp;
  }
}
