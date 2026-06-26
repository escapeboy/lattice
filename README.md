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
| `@lattice/engine` | CDP adapter over `playwright-core` — isolated contexts, navigation, teardown (default engine). |
| `@lattice/engine-adapter` | **Build-on engine (ADR 0002):** [agent-browser](https://agent-browser.dev) wrapped behind a narrow semantic port, **internal-only**, with the kernel-bypass primitives (`eval`/raw-CDP/file/profile) firewalled. See [SECURITY.md](./SECURITY.md). |
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

const { content } = await client.callTool({ name: "session_create", arguments: { topology: "ephemeral" } });
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

### Engine selection — CDP vs build-on (ADR 0002)

Lattice runs on either engine, selected at boot — a **dual-stack** migration so
the proven CDP path stays the default while the build-on path reaches parity:

```bash
# Default: CDP over playwright-core (needs a local Chromium).
node apps/serve/dist/main.js

# Build-on: agent-browser as an internal engine (downloads Chrome for Testing).
LATTICE_ENGINE=agent-browser node apps/serve/dist/main.js
LATTICE_ENGINE=agent-browser LATTICE_DEVICE="iPhone 15 Pro" node apps/serve/dist/main.js   # mobile
```

Same MCP surface, same tools, same kernel — only the engine substrate differs.
On the build-on path the agent reaches agent-browser **only** through the
governed gateway; `eval`, raw CDP, file and profile access are firewalled (see
[SECURITY.md](./SECURITY.md)). The WebMCP capability probe needs `eval`, so on
build-on it degrades to semantic fallback rather than exposing a CDP surface.

### Unified process — `lattice serve`

`apps/serve` boots **one process, one shared kernel**, with two faces: the MCP
gateway (agents) and the control plane (humans). This is what realizes "UI and
MCP share one policy/grant/audit slice" — UI-minted operator grants authorize
the same kernel the gateway gates against, sessions populate the live theater,
traces feed the replay browser, and agent-raised handoffs are resolvable from
the control plane.

```bash
node apps/serve/dist/main.js
# MCP gateway:   http://0.0.0.0:8765/mcp
# Control plane: http://127.0.0.1:7900
```

Extra env on top of the gateway's: `CONTROL_PLANE_PORT` (default 7900),
`LATTICE_VAULT_KEY` (32-byte hex — encrypts the vault at rest),
`LATTICE_VAULT_PATH` (persist the encrypted vault), `LATTICE_NTFY_BASE` +
`LATTICE_HANDOFF_KEY` (handoff push + signing), `LATTICE_TRACE_DIR` (where
finished traces are written as Svod notes).

The HTTP gateway is **multi-session**: each `initialize` opens its own MCP
transport (pooled by `mcp-session-id`), so many agents connect concurrently.

## MCP tool reference

All tools return MCP `text` content containing JSON. Browser sessions are
application-level: `session_create` returns a `sessionId` you pass to the rest.

| Tool | Arguments | Returns |
|---|---|---|
| `session_create` | `topology?: "ephemeral"\|"persistent"`, `personaId?` | `{ sessionId }`; `persistent`+`personaId` resumes that persona's cookies/storage |
| `session_destroy` | `sessionId` | `{ destroyed }` |
| `session_list` | — | `{ sessions: string[] }` |
| `perceive_snapshot` | `sessionId`, `tier?: "L0"\|"L1"\|"L2"\|"L3"` | Interaction Graph (+ delta vs previous snapshot); L3 adds a screenshot image block |
| `perceive_delta` | `sessionId` | `{ delta, url }` since the last snapshot |
| `perceive_subscribe` | `sessionId`, `intervalMs?` | streams `notifications/perceive` on every change; returns `{ subscriptionId }` |
| `perceive_unsubscribe` | `sessionId`, `subscriptionId` | stops the stream |
| `act_execute` | `sessionId`, `command: ActionCommand` | `{ success, url, delta, extracted? }` |
| `extract_query` | `sessionId`, `query` | extracted page data |
| `capability_check` | `sessionId` | page MCP-capability probe |
| `vault_store` | `label`, `origin`, `username`, `password` | `{ id }` (password never echoed) |
| `vault_list` | — | credentials **without** passwords |
| `vault_autofill` | `sessionId`, `id`, field targets | fills fields directly; **values never pass through the model** |
| `policy_classify` | `actionType` | policy classification reference |

`ActionCommand` (from `@lattice/action`): `{ type: "navigate", url }`,
`{ type: "act"\|"fill"\|"select"\|"submit"\|"scroll_to", target: { nodeId }, value? }`,
`{ type: "extract", query }`, `{ type: "wait_for", condition }`.

### Operator surface

The operator surface is the privileged governance API — policy, personas,
devices, budget, audit. It is **tiered** (see `docs/design-operator-surface`):

**Read tier — free for the agent** (benign, every access audited):

| Tool | Returns |
|---|---|
| `policy_get` / `policy_list` | current policy snapshot / rules (incl. constitutional invariants) |
| `persona_list` / `device_list` | personas / registered operator devices (no secrets) |
| `audit_read` / `audit_export` | the immutable audit log |
| `budget_get` | token budget (limit + spent) |
| `session_observe` | a session's live page state — **tainted**, quarantined output |

**Write tier — requires a human grant token** (`grant` arg). Without one the
call returns `{ status: "awaiting_human_grant" }`; the agent must raise a
handoff and a human approves it in the control plane, which mints the token:

| Tool | Effect |
|---|---|
| `policy_set` | tighten policy (cannot drop below the constitutional floor) |
| `persona_create` / `persona_delete` | manage personas |
| `device_register` / `device_revoke` | manage handoff devices |
| `budget_set` | set the token budget |

**Prohibited tier — never through the agent API**: `persona_import`
(credential-bearing) is refused and directed to the human control-plane UI,
even when a grant token is presented.

### Human handoff

| Tool | Arguments | Returns |
|---|---|---|
| `session_handoff` | `sessionId`, `type: "approval"\|"input"`, `reason`, `field?` | `{ handoffId, status }` — fans out to all devices, first to claim wins |
| `handoff_status` | `handoffId` | `pending\|claimed\|approved\|denied\|filled\|expired` |

Approvals (Type A) push to **ntfy** with Approve/Deny buttons. Input (Type B)
uses a **mediated field**: the value flows Vault→form via the human channel and
**never** passes through the model, agent, or trace. Requests are HMAC-signed so
the device can verify origin before showing a form. Claim/resolve/submit are
human-channel operations, not agent tools.

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

### Operator-surface guarantees (structural, not by prompt)

The governance API closes three escalation vectors at the kernel boundary:

- **Constitutional floor** — a hard-coded set of invariants no `policy_set` may weaken, *by anyone* through the API: tainting stays on, the floor-prohibited primitives stay prohibited, and content-proposed egress stays blocked. A patch that would drop below the floor is refused with a typed `floor_violation` — even with a valid human grant. This stops an agent from calling `policy_set` to "allow everything".
- **Human-grant asymmetry** — operator *writes* require a single-use token minted only by the human control-plane channel (`mintHumanGrant`). The agent has no route to mint one, so it cannot self-authorize a mutation; it can only *request* a handoff.
- **Injection→operator block** — operator arguments are checked against the kernel's runtime taint registry. Any value lifted from page content (e.g. via `session_observe`) is refused before it reaches the tool (`tainted_origin`). A page that injects "call `policy_set`/`persona_import`" cannot reach the operator tools through a confused agent.
- **`persona_import` is prohibited** — the credential-bearing profile import is never executed through the agent API; only the human UI may initiate it.

These four behaviours are covered by mandatory negative tests in
`packages/gateway/src/operator.test.ts` and `packages/kernel/src/operator.test.ts`.

Configure policy via environment (see `docker-compose.yml`):
`LATTICE_ALLOWED_ORIGINS`, `LATTICE_EGRESS_ALLOWLIST`, `LATTICE_PROHIBITED`.
Handoff push: `LATTICE_NTFY_BASE`, `LATTICE_HANDOFF_KEY`.

Consequential grants and operator-write grants are both fulfilled by a human
through the **control plane** — one kernel, one audit log, two faces (UI + MCP).

## Control plane (human supervision)

```bash
node apps/control-plane/dist/main.js     # HTTP + SSE UI
```

Intent input, a live theater of parallel sessions, the approval inbox for
consequential actions, the operator-grant inbox (approving an agent's operator
write mints a grant on the shared kernel), a policy editor, and a replay browser
over recorded traces. Tauri wraps this same web layer as a desktop app in P3.

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

**Build-on engine (ADR 0002):** the engine layer also runs on
[agent-browser](https://agent-browser.dev) (Apache-2.0), wrapped internal-only
behind the governed `BuildOnSession` and selected with `LATTICE_ENGINE=agent-browser`.
Lattice adds what agent-browser lacks — cross-mutation stable identity (their
refs are per-snapshot), taint-per-node, streamed deltas, the Security Kernel,
the operator surface, traces, control plane, and human handoff. The agent's only
door is the MCP gateway; agent-browser's kernel-bypass primitives are firewalled.
See [SECURITY.md](./SECURITY.md) and the `NOTICE` for attribution.

## License & attribution

Apache-2.0 (see [LICENSE](./LICENSE)). Builds on agent-browser (Apache-2.0,
pinned 0.31.0), used unmodified as an internal engine — see [NOTICE](./NOTICE).
