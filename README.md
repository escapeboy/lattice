# Lattice

An AI-first browser runtime. Lattice gives agents a **semantic** view of the web
(an Interaction Graph instead of raw DOM/pixels), **trusted** semantic actions, a
concurrency runtime for many parallel browser contexts, a **security kernel**
(tainting, policy classification, capability gating, egress firewall), and an
**MCP gateway** so any MCP-speaking agent — including Claude Code — can drive a
browser end-to-end.

This repository is the **P0 + P1-prototype**: a CDP-based runtime in TypeScript
that proves the interface, the token economics, and the security primitives. The
native Chromium fork (P3, Rust/C++) is intentionally out of scope here — see
[ADR 0001](https://-/projects/lattice/docs/adr/0001-language-and-stack) in the
project's Svod vault.

> License: **Apache-2.0** (see [LICENSE](./LICENSE)).

## Architecture

A pnpm monorepo of focused packages:

| Package | Responsibility |
|---|---|
| `@lattice/engine` | CDP adapter over `playwright-core` — isolated contexts, navigation, teardown. |
| `@lattice/perception` | Interaction Graph from DOM + Accessibility tree + layout. Stable node identity, fidelity tiers **L0/L1/L2/L3**, deltas. |
| `@lattice/action` | Semantic actions (`navigate`/`act`/`fill`/`select`/`submit`/`extract`/…) over **trusted** CDP Input, with engine-owned settling. |
| `@lattice/runtime` | Scheduler + resource governor for N concurrent contexts; ephemeral/persistent topologies; fan-out. |
| `@lattice/kernel` | Security kernel — content tainting, policy classification, capability gating, egress firewall, audit log. |
| `@lattice/gateway` | MCP server (stdio **and** Streamable HTTP). Tool groups: `session.*` `perceive.*` `act.*` `extract.*` `capability.*` `vault.*` `policy.*`. |
| `@lattice/observability` | Structured, diffable traces; deterministic replay; metrics; Svod emission. |
| `@lattice/sdk-ts` | Thin TypeScript client. |
| `apps/control-plane` | Human supervision UI (HTTP + SSE): intent input, live session theater, approval inbox, policy editor, replay browser. |
| `apps/demo` | Demo agent + mobile responsive sanity check. |

## Quickstart (local dev)

Requires Node 22+, pnpm (via `corepack enable`), and a Chromium-compatible
browser on `PATH` (or set `CHROME_EXECUTABLE`).

```bash
corepack enable
pnpm install
pnpm -r build
pnpm -r test          # integration tests auto-skip if no browser is found
```

Run the mobile responsive demo against the bundled fixture:

```bash
node apps/demo/dist/main.js
# → answers "does the navigation collapse at 390px?" purely via perception,
#   and prints trace metrics. Add `--out trace.jsonl` to save the trace.
```

Run the gateway over stdio (for a local MCP client that spawns the process):

```bash
LATTICE_TRANSPORT=stdio node packages/gateway/dist/main.js
```

## Self-hosted gateway (Docker)

The self-hosted gateway serves MCP over **Streamable HTTP** at `/mcp`.

```bash
docker compose up --build
# Gateway: http://localhost:8765/mcp   Health: http://localhost:8765/health
```

Point any MCP client at `http://<host>:8765/mcp`. Minimal connect:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8765/mcp")));

const { content } = await client.callTool({ name: "session.create", arguments: { topology: "ephemeral" } });
// → { sessionId }  — thread this sessionId through perceive.* / act.* / extract.*
```

### Deploying to a single host (e.g. Hetzner)

```bash
git clone <repo> lattice && cd lattice
# Tighten the policy for your deployment:
export LATTICE_ALLOWED_ORIGINS="https://app.example.com"
export LATTICE_EGRESS_ALLOWLIST="https://api.example.com"
docker compose up -d --build
curl -fsS http://localhost:8765/health     # {"status":"ok",...}
```

Put a TLS-terminating reverse proxy (Caddy/nginx) in front for public exposure.
Headless Chromium needs a large `/dev/shm`; the compose file sets `shm_size: 1gb`.

## MCP tool reference

All tools return MCP `text` content containing JSON. Browser sessions are
application-level: `session.create` returns a `sessionId` you pass to the rest.

| Tool | Arguments | Returns |
|---|---|---|
| `session.create` | `topology?: "ephemeral"\|"persistent"` | `{ sessionId }` |
| `session.destroy` | `sessionId` | `{ destroyed }` |
| `session.list` | — | `{ sessions: string[] }` |
| `perceive.snapshot` | `sessionId`, `tier?: "L0"\|"L1"\|"L2"` | Interaction Graph (+ delta vs previous snapshot) |
| `perceive.delta` | `sessionId` | `{ delta, url }` since the last snapshot |
| `act.execute` | `sessionId`, `command: ActionCommand` | `{ success, url, delta, extracted? }` |
| `extract.query` | `sessionId`, `query` | extracted page data |
| `capability.check` | `sessionId` | page MCP-capability probe |
| `vault.store` | `label`, `origin`, `username`, `password` | `{ id }` (password never echoed) |
| `vault.list` | — | credentials **without** passwords |
| `vault.autofill` | `sessionId`, `id`, field targets | fills fields directly; **values never pass through the model** |
| `policy.classify` | `actionType` | policy classification reference |

`ActionCommand` (from `@lattice/action`): `{ type: "navigate", url }`,
`{ type: "act"\|"fill"\|"select"\|"submit"\|"scroll_to", target: { nodeId }, value? }`,
`{ type: "extract", query }`, `{ type: "wait_for", condition }`.

### Fidelity tiers

- **L0** — structural summary (counts, title, url). Cheapest.
- **L1** — the Interaction Graph: roles, labels, state, value, relations, stable IDs. The default; < 5KB for a typical page.
- **L2 / L3** — L1 plus geometry (box model). Request only where pixel-level reasoning is needed.

## Security model

The kernel mediates every consequential effect. Its guarantees:

- **Content tainting** — perception output is marked tainted (`TaintedStr`) and delivered to the agent through a quarantined channel. Page text **cannot** be promoted to instruction context — enforced at the type level. Prompt-injection embedded in a page does not change agent behavior.
- **Policy classification** — every action is classified `read` / `benign` / `consequential` / `prohibited`. `consequential` actions (submit, checkout, delete, …) require an explicit **grant**; without one they are blocked.
- **Capability gating** — actions are intercepted **before** they take effect, not after.
- **Egress firewall** — form/fetch destinations are checked against an allowlist. A destination that originates from page **content** (not the task) is blocked.
- **Prohibited primitives** — CAPTCHA solving, account creation, ACL changes, transfers, and hard deletes are refused and escalated, regardless of other config.
- **Audit log** — every grant and egress decision is recorded.

Configure policy via environment (see `docker-compose.yml`):
`LATTICE_ALLOWED_ORIGINS`, `LATTICE_EGRESS_ALLOWLIST`, `LATTICE_PROHIBITED`.

Grants are fulfilled by a human through the **control plane** approval inbox — a
one-tap approve/deny that resolves the kernel's pending grant.

## Control plane (human supervision)

```bash
node apps/control-plane/dist/main.js     # HTTP + SSE UI
```

Intent input, a live theater of parallel sessions, the approval inbox for
consequential actions, a policy editor, and a replay browser over recorded
traces. Tauri wraps this same web layer as a desktop app in P3.

## Observability

Every session produces a structured, diffable trace (perception snapshots,
actions, deltas, grants, network) emitted as JSONL and to the project's Svod
trace store. Traces **replay deterministically**; replaying against a changed
site surfaces the exact diff. See `@lattice/observability`.

## Status & roadmap

P0 + P1-prototype is complete: an external agent drives a full
perceive→act→extract cycle over MCP; injection/egress/gating tests pass; traces
land in Svod; the self-hosted Docker gateway runs. The next decision point is
**P3** — the native Chromium fork — which is a deliberate, human-gated step and
is not started automatically.
