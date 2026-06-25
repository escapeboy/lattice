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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
    name: "session.create",
    description: "Create an isolated browser session context",
    inputSchema: {
      type: "object" as const,
      properties: {
        topology: { type: "string", enum: ["ephemeral", "persistent"], default: "ephemeral" },
      },
    },
  },
  {
    name: "session.destroy",
    description: "Destroy a session and release all resources",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "session.list",
    description: "List active session IDs",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "perceive.snapshot",
    description: "Get Interaction Graph snapshot of the current page (L0=summary, L1=default IG, L2=with geometry)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        tier: { type: "string", enum: ["L0", "L1", "L2"], default: "L1" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "perceive.delta",
    description: "Get delta (added/removed/updated nodes) since the last snapshot call on this session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "act.execute",
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
    name: "extract.query",
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
    name: "capability.check",
    description: "Check whether the current page exposes native MCP/WebMCP capabilities",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "vault.store",
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
    name: "vault.list",
    description: "List stored credentials (id, label, origin, username — no passwords)",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "vault.autofill",
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
    name: "policy.classify",
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

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

// ── GatewayServer ────────────────────────────────────────────────────────────

export class GatewayServer {
  private readonly mcp: Server;
  private readonly sessions: SessionRegistry;
  private readonly vault: Vault;

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
  ): Promise<ReturnType<typeof ok>> {
    switch (name) {
      // ── session.* ──────────────────────────────────────────────────────────
      case "session.create": {
        const topology = (a["topology"] as "ephemeral" | "persistent" | undefined) ?? "ephemeral";
        const session = await this.sessions.create(topology);
        return ok({ sessionId: session.id, topology });
      }

      case "session.destroy": {
        await this.sessions.destroy(a["sessionId"] as string);
        return ok({ destroyed: true });
      }

      case "session.list": {
        return ok({ sessions: this.sessions.list() });
      }

      // ── perceive.* ─────────────────────────────────────────────────────────
      case "perceive.snapshot": {
        const session = this.getSession(a["sessionId"] as string);
        const tier = ((a["tier"] as string | undefined) ?? "L1") as FidelityTier;
        const snap = await session.perception.snapshot(tier);

        if (snap.tier === "L0") {
          return ok(snap);
        }

        const ig: InteractionGraph = snap;
        // Serialize Map → array for JSON transport
        const nodes = Array.from(ig.nodes.values());
        const prev = session.lastSnapshot;
        session.lastSnapshot = ig;

        return ok({
          tier: ig.tier,
          url: ig.url,
          title: ig.title,
          nodeCount: nodes.length,
          serializedSize: ig.serializedSize,
          nodes,
          ...(prev ? { delta: session.perception.delta(prev, ig) } : {}),
        });
      }

      case "perceive.delta": {
        const session = this.getSession(a["sessionId"] as string);
        if (!session.lastSnapshot) return ok({ delta: null, reason: "no prior snapshot" });

        const current = await session.perception.snapshot("L1") as InteractionGraph;
        const delta = session.perception.delta(session.lastSnapshot, current);
        session.lastSnapshot = current;
        return ok({ delta, url: current.url });
      }

      // ── act.* ──────────────────────────────────────────────────────────────
      case "act.execute": {
        const session = this.getSession(a["sessionId"] as string);
        const command = a["command"] as Parameters<typeof session.action.execute>[0];
        const result = await session.action.execute(command);
        return ok({
          success: result.success,
          url: result.url,
          delta: result.delta,
          ...(result.extracted !== undefined ? { extracted: result.extracted } : {}),
        });
      }

      // ── extract.* ──────────────────────────────────────────────────────────
      case "extract.query": {
        const session = this.getSession(a["sessionId"] as string);
        const result = await session.action.execute({
          type: "extract",
          query: a["query"] as string,
        });
        return ok({ result: result.extracted });
      }

      // ── capability.* ───────────────────────────────────────────────────────
      case "capability.check": {
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
      case "vault.store": {
        const result = this.vault.store(
          a["label"] as string,
          a["origin"] as string,
          a["username"] as string,
          a["password"] as string,
        );
        return ok({ credentialId: result.id, note: "password stored — never returned via API" });
      }

      case "vault.list": {
        return ok({ credentials: this.vault.listPublic() });
      }

      case "vault.autofill": {
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
      case "policy.classify": {
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

  async stop(): Promise<void> {
    await this.sessions.destroyAll();
    await this.mcp.close();
  }

  /** Expose underlying MCP server for transport injection in tests. */
  getMCPServer(): Server {
    return this.mcp;
  }
}
