# Lattice — Quickstart

Zero to a first **perceive → act** cycle over MCP. Every command below was run
from a clean checkout and verified end-to-end; the output shapes are real.

Lattice is a governance browser runtime: it gives an MCP-speaking agent a
**semantic** view of a page (an Interaction Graph, not raw DOM/pixels),
**trusted** semantic actions, and a **security kernel** (content tainting,
policy classification, capability gating, egress firewall) that mediates every
consequential effect. This guide boots the unified `lattice serve` process and
drives one session through it.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Node 22+** | Verified on Node 25. |
| **pnpm 10** | `corepack enable` provides the pinned `pnpm@10.33.2` from `package.json`. |
| **A Chromium** | Only needed for the **CDP** engine (`LATTICE_ENGINE=cdp`). The **default** build-on engine downloads its own Chrome for Testing on first run. |

The CDP engine auto-detects a browser at the usual locations (Google Chrome /
Chromium on macOS and Linux). If yours is elsewhere, set `CHROME_EXECUTABLE` to
its absolute path. The build-on engine needs no `CHROME_EXECUTABLE`.

---

## 2. Build

```bash
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles all 15 workspace projects with `tsc`. Expected tail:

```
apps/demo build: Done
packages/gateway build: Done
apps/control-plane build: Done
apps/serve build: Done
```

The boot artifact is `apps/serve/dist/main.js`.

Optional — run the test suite (browser-dependent integration tests auto-skip
when no browser is found):

```bash
pnpm test
```

---

## 3. Boot `lattice serve`

`lattice serve` boots **one process, one shared kernel** with two faces: the MCP
gateway (for agents) and the control plane (for humans).

```bash
node apps/serve/dist/main.js
```

It prints — **on stderr** — the two URLs and, because no tokens were set, the
auto-generated ones for this run:

```
LATTICE_CP_TOKEN unset — generated for this run: 457951a6-0905-4dbd-8ee9-8c8e0250bbf3
LATTICE_MCP_TOKEN unset — generated for this run: 38fec932-01d4-440d-b0d1-e2eb92b4be90
Lattice serve — MCP gateway: http://0.0.0.0:8765/mcp
Lattice serve — control plane: http://127.0.0.1:7900
```

Copy the `LATTICE_MCP_TOKEN` value — you need it to call the gateway.

> **Secure by default.** The `/mcp` endpoint is **always** token-gated. If you
> don't set `LATTICE_MCP_TOKEN`, the process generates an ephemeral one and
> prints it (above) rather than serving open — so a real deployment should set
> its own. `/health` stays open for liveness checks.

**Engine — secure default vs. opt-in.** With no `LATTICE_ENGINE` set, `serve`
runs the **build-on** engine (agent-browser behind the governed session), where
`eval`, raw CDP, and file access are structurally absent. The raw-CDP engine is
an explicit dev-only opt-in:

```bash
# Default (build-on / firewalled). Downloads Chrome for Testing on first run.
node apps/serve/dist/main.js

# Opt-in raw-CDP engine — uses a local Chromium; lacks the build-on firewall.
LATTICE_ENGINE=cdp node apps/serve/dist/main.js
```

Choosing `cdp` prints a warning to that effect. Same MCP surface, same tools,
same kernel — only the engine substrate differs.

### Verify it booted (from a second terminal)

```bash
# /health is open — expect {"status":"ok",...}
curl -s http://127.0.0.1:8765/health

# /mcp without the token is rejected — expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Verified responses:

```
{"status":"ok","server":"lattice-gateway","version":"0.1.0","sessions":0}
401
```

---

## 4. First agent cycle (perceive → act → extract)

The agent's only door is the MCP gateway. Connect with the standard MCP
Streamable-HTTP client, passing the token as a **Bearer** header.

> The `@lattice/sdk-ts` client is a scaffold (`createClient` throws
> *"Not implemented"*) — drive the gateway with the MCP SDK directly, as below.

Create `first-cycle.mjs` **inside the repo** (so the workspace-installed
`@modelcontextprotocol/sdk` resolves — e.g. in `apps/serve/`):

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = "http://127.0.0.1:8765/mcp";
const token = process.env.LATTICE_MCP_TOKEN; // the value serve printed

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "first-cycle", version: "1.0.0" });
await client.connect(transport);

const parse = (r) => JSON.parse(r.content[0].text); // tools return JSON-as-text

// 1. Open an isolated browser session.
const { sessionId } = parse(
  await client.callTool({ name: "session_create", arguments: { topology: "ephemeral" } }),
);

// 2. Act: navigate.
const nav = parse(await client.callTool({
  name: "act_execute",
  arguments: { sessionId, command: { type: "navigate", url: "https://example.com/" } },
}));
console.log("navigate:", nav.success, nav.url);

// 3. Perceive: the L1 Interaction Graph (role + label per node, stable ids).
const snap = parse(await client.callTool({
  name: "perceive_snapshot",
  arguments: { sessionId, tier: "L1" },
}));
console.log("perceive:", snap.title, `${snap.nodeCount} nodes`);
console.log(snap.nodes.slice(0, 2));

// 4. Extract a value, and see the gate classify a consequential action.
console.log("extract:", parse(await client.callTool({
  name: "extract_query", arguments: { sessionId, query: "text:h1" },
})));
console.log("classify submit:", parse(await client.callTool({
  name: "policy_classify", arguments: { actionType: "submit" },
})));

await client.callTool({ name: "session_destroy", arguments: { sessionId } });
await client.close();
```

Run it from the repo root, pointing at your token:

```bash
LATTICE_MCP_TOKEN=<the-token-serve-printed> node apps/serve/first-cycle.mjs
```

Verified output (CDP engine against `https://example.com/`):

```
navigate: true https://example.com/
perceive: Example Domain 2 nodes
[
  { id: 'heading-204421606346', role: 'heading', label: 'Example Domain', level: 1 },
  { id: 'link-177dfdf6ca39', role: 'link', label: 'Learn more', href: 'https://iana.org/domains/example' }
]
extract: { result: 'Example Domain' }
classify submit: { actionType: 'submit', classification: 'consequential' }
```

That is the whole loop: an external agent opened a session, drove a navigation,
received a compact semantic snapshot (2 nodes, ~hundreds of bytes — not a DOM
dump), pulled a value, and saw the kernel classify `submit` as `consequential`
(which would require a human grant to actually execute). Remember to delete
`first-cycle.mjs` afterward — it is not part of the repo.

### The MCP tool surface (confirmed names)

Tools return MCP `text` content containing JSON. Sessions are application-level:
`session_create` returns a `sessionId` you thread through the rest.

| Tool | Arguments | Returns |
|---|---|---|
| `session_create` | `topology?`, `personaId?` | `{ sessionId, topology }` |
| `session_destroy` / `session_list` | `sessionId` / — | `{ destroyed }` / `{ sessions }` |
| `perceive_snapshot` | `sessionId`, `tier?: L0\|L1\|L2\|L3` | Interaction Graph (+ delta; L3 adds a screenshot) |
| `perceive_delta` / `perceive_subscribe` / `perceive_unsubscribe` | `sessionId`, … | deltas since last snapshot / live delta stream |
| `act_execute` | `sessionId`, `command` | `{ success, url, delta, extracted? }` |
| `extract_query` | `sessionId`, `query` | `{ result }` (`text:<css>`, `attr:<css>@<attr>`, `value:<css>`, or a JS expr) |
| `capability_check` / `capability_list` | `sessionId` / — | WebMCP fast-path probe / cached per-origin map |
| `vault_store` / `vault_list` / `vault_autofill` | … | credential store/list/mediated autofill (values never echoed) |
| `policy_classify` | `actionType` | `read\|benign\|consequential\|prohibited` |

`command` (for `act_execute`): `{ type: "navigate", url }` ·
`{ type: "act"\|"fill"\|"select"\|"submit"\|"scroll_to", target: { nodeId }, value? }` ·
`{ type: "extract", query }` · `{ type: "wait_for", condition }`.

There is also an **operator surface** (policy/persona/device/budget/audit) split
into a free *read* tier, a *write* tier requiring a human grant token, and a
*prohibited* tier (`persona_import`) that the agent API always refuses. See the
README's "Operator surface" and "Human handoff" sections.

---

## 5. Secure-by-default configuration

All policy is environment-driven. A `.env`-style block of the real variables:

```bash
# ── Gateway / control-plane endpoints ───────────────────────────────────────
LATTICE_PORT=8765                 # MCP gateway port
LATTICE_HOST=0.0.0.0              # gateway bind host
CONTROL_PLANE_PORT=7900           # control-plane UI port (binds 127.0.0.1)

# ── Auth (auto-generated + printed if unset; /mcp is ALWAYS gated) ───────────
LATTICE_MCP_TOKEN=                # Bearer token required on /mcp
LATTICE_CP_TOKEN=                 # Bearer token for control-plane writes

# ── Engine (UNSET = build-on / firewalled DEFAULT) ───────────────────────────
LATTICE_ENGINE=                   # "cdp" = opt-in raw-CDP (dev-only, no firewall)
CHROME_EXECUTABLE=                # absolute path to Chromium (CDP engine only)
LATTICE_HEADED=                   # "1" runs the engine headed
LATTICE_DEVICE=                   # e.g. "iPhone 15 Pro" (build-on mobile emulation)

# ── Security policy (tighten for your deployment) ────────────────────────────
LATTICE_ALLOWED_ORIGINS=          # comma-sep origins the task may navigate to
LATTICE_EGRESS_ALLOWLIST=         # comma-sep destinations the egress proxy permits
LATTICE_PROHIBITED=               # extra prohibited action types

# ── Vault / handoff / traces ─────────────────────────────────────────────────
LATTICE_VAULT_KEY=                # 32-byte hex — encrypts the vault at rest
LATTICE_VAULT_PATH=               # persist the encrypted vault
LATTICE_NTFY_BASE=                # ntfy base URL for handoff push
LATTICE_HANDOFF_KEY=              # HMAC key signing handoff requests
LATTICE_TRACE_DIR=./traces        # where finished traces are written (Svod notes)
LATTICE_PII_FULL_ORIGINS=         # origins logged un-redacted (default: all redacted)
```

What "secure by default" means concretely, all verified at boot:

- **MCP token gating is unconditional.** Leaving `LATTICE_MCP_TOKEN` unset
  generates+prints an ephemeral token; it never serves open. A `/mcp` call
  without `Authorization: Bearer <token>` returns `401`.
- **The build-on engine is the default.** You opt *into* the weaker raw-CDP
  stack with `LATTICE_ENGINE=cdp` (and get a warning); you never fall into it.
- **The egress firewall turns on with an allowlist.** Set
  `LATTICE_ALLOWED_ORIGINS` and/or `LATTICE_EGRESS_ALLOWLIST` and every browser
  request routes through the Lattice forward proxy. Verified boot line:
  `Egress firewall active — browser traffic gated through http://127.0.0.1:<port> (origin allowlist).`
  An **empty** allowlist is the dev-unrestricted default (no proxy).
- **Consequential actions need a grant.** `policy_classify submit` →
  `consequential`; executing it requires a human grant minted in the control
  plane. Page content reaching the agent is tainted and cannot be promoted into
  instructions or operator-write arguments.

---

## 6. Self-hosted (Docker)

A `Dockerfile` and `docker-compose.yml` ship in the repo. Compose defaults to the
**build-on (firewalled)** engine (`LATTICE_ENGINE: "${LATTICE_ENGINE:-agent-browser}"`),
mirroring `lattice serve`; agent-browser downloads its own Chrome for Testing on
first run. `LATTICE_ENGINE=cdp` is an explicit, unsafe dev-only override.

```bash
docker compose up --build
# Gateway: http://localhost:8765/mcp   Health: http://localhost:8765/health
```

A bare `docker compose up` is **18/20** governance wired (egress unrestricted by
the dev default). Set an origin allowlist to start the egress proxy → **20/20**.
Tighten policy for a real host before exposing it:

```bash
export LATTICE_ALLOWED_ORIGINS="https://app.example.com"
export LATTICE_EGRESS_ALLOWLIST="https://api.example.com"
docker compose up -d --build
curl -fsS http://localhost:8765/health
```

Put a TLS-terminating reverse proxy in front for public exposure. Headless
Chromium needs a large `/dev/shm`; the compose file sets `shm_size: 1gb`.

> The compose/Docker path is provided in-repo but was **not** rebuilt as part of
> verifying this quickstart (the `node apps/serve/dist/main.js` path above was).
> The compose env wiring matches `apps/serve/src/main.ts`.

---

## Where to go next

- **README.md** — full architecture, the package table, the complete MCP and
  operator tool reference, and the security model.
- **SECURITY.md** — the build-on firewall boundary (ADR 0002) and the kernel
  invariants.
- **`packages/eval`** — the perception-economics and governance evals.
- **Control plane** — open `http://127.0.0.1:7900` while `serve` runs for the
  human supervision UI (live theater, approval inbox, policy editor, replay).
