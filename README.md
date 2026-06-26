# Lattice

**A governance browser runtime for agents — a firewalled-by-default build-on
stack whose security moat is *measured*, not promised behind an opt-in flag.**

A 22-attack injection/bypass corpus, adjudicated by the **real** kernel and
firewall (no mocks): the kernel **logic** blocks **22/22 (100%)** at the function
level — versus **8/22** for a fully-hardened agent-browser and **0/22** for the
bare engine. What a deployment **enforces on the real browser path** is narrower
and we say so: **18/22 wired zero-config** by the firewalled build-on engine;
setting `LATTICE_ALLOWED_ORIGINS` starts the egress proxy → **20/22**. The proxy
gates **HTTP** egress; it does **not** gate **HTTPS** sub-resource egress
(agent-browser/Chromium doesn't route HTTPS through it — verified), so **2 HTTPS
egress-exfil vectors stay unwired** on the app path today. There is **no "20/20 /
fully wired" claim**: HTTPS app-gating is roadmap; the compensating control now is
a network/infra egress layer (squid/pf). The egress decision is also
**origin-level**, not provenance-aware. Numbers come from an in-repo eval, pinned
by CI, not asserted by hand ([`packages/eval`](./packages/eval),
[SECURITY.md](./SECURITY.md)).

Lattice gives an agent a **semantic** view of the web (an Interaction Graph, not
raw DOM or pixels), **trusted** semantic actions, a concurrency runtime for many
parallel browser contexts, a **security kernel** (tainting, capability gating,
egress firewall, a constitutional floor), per-domain **recipes**, and an **MCP
gateway** so any MCP-speaking agent — Claude Code included — can drive a browser
end to end.

> Apache-2.0 ([LICENSE](./LICENSE)) · builds on [agent-browser](https://agent-browser.dev)
> (Apache-2.0, used unmodified as an **internal** engine, ADR 0002 — see
> [NOTICE](./NOTICE)) · a research prototype, not a finished product.

## What it is / who it's for

- **Agent builders** who need a browser tool that won't get prompt-injected into
  exfiltrating data or self-authorizing a purchase. Governance here is
  *structural* (type-level taint, a kernel choke point), not a system-prompt plea.
- **Ops / platform teams** self-hosting an agent fleet: one process, one shared
  kernel, one audit log; egress-allowlisted; `docker compose up`.
- **Regulated industries** (finance, health, gov): every consequential action is
  human-granted and audited; PII is redacted before traces are persisted; the
  trust boundary lives in code, not in a vendor promise.
- **Operators on a Mac**: a native macOS app (menubar + control plane) that
  supervises the whole stack, keeps vault secrets in the Keychain, and ships the
  egress firewall **on by default** (HTTP egress gated → 20/22; HTTPS not yet
  app-gated). Windows/Linux run console-only.
  See [Desktop (macOS)](#desktop-macos--native-app).

## Differentiators — honest, measured

| Dimension | Number | Against |
|---|---|---|
| **Governance** | kernel logic blocks **22/22** · real-path **18/22 wired zero-config**, **20/22 with `LATTICE_ALLOWED_ORIGINS`** (HTTP egress; 2 HTTPS egress-exfil vectors not app-gated) | hardened agent-browser **8/22** · bare **0/22** |
| **Economics** (vs the Chrome method) | **10.2× cheaper** than a screenshot agent · **4.1×** than raw-DOM | — |
| **Economics** (vs a semantic engine) | **1.64×** vs agent-browser — *we build ON it; no token win is claimed here* | agent-browser |
| **Recipe** on a known flow | planning tokens **6.4× lower** (669→105) · round-trips **5→1** · drift success **80%→100%** | a naive baked-locator recipe |
| **Reliability** across re-render | **100%** stable-NodeId vs **92%** naive volatile-ref caching (eval-computed) | per-snapshot refs |

All numbers come from the in-repo eval (`packages/eval`) and are pinned by CI
tests, not hand-asserted. The opponent for the **economics** is the **Chrome /
screenshot method** — feeding the model pixels (≈1–2K vision tokens/step) or a
raw-DOM dump (≈10–50K text tokens/step) — **not** a terse semantic engine. On
single-page perception tokens against agent-browser the two are the same order of
magnitude, and we say so. The real differentiator against a semantic engine is
governance + cross-mutation stable identity + streamed deltas + the recipe moat.

> **Egress scope (honest).** Two stacked limitations, neither oversold:
> (1) the proxy is **active only when an allowlist is configured** — a bare
> `docker compose up` leaves egress unrestricted (18/22); set
> `LATTICE_ALLOWED_ORIGINS` to turn it on. (2) The proxy gates **HTTP only** —
> agent-browser/Chromium does **not** route HTTPS browser traffic through it
> (verified across env vars, `--proxy`, and raw `--proxy-server`), so the **2
> HTTPS `egress-exfil` vectors stay unwired** even when configured → **20/22, not
> a full 22**. HTTPS sub-resource exfil is blocked by `checkEgress` *logic* but
> not enforced on the real path; top-level navigation is separately kernel-scoped.
> Compensating control today: a network/infra egress layer (squid/pf). App-level
> HTTPS gating is roadmap. The HTTP decision is also **origin-level**, not
> provenance-aware. See [SECURITY.md](./SECURITY.md) §4c, §6.

## Where it breaks

Honesty builds more trust than a flawless facade. We ran the **real** engine +
proxy against **10 live sites outside the eval corpus** (heavy SPA, content,
login form, e-commerce, shadow-DOM, slow/heavy, consent-wall, table-grid list,
WebGL, RTL). All 10 navigated and snapshotted; **no engine crash, no state
corruption, and no egress leak** (a blocked destination was never reached). The
real, current gaps it surfaced:

- **Exact-label action/recipe resolution is too strict** *(high)* — both the
  action path and `resolveLocator` (recipe) do a strict `label === label` compare.
  Real labels carry trailing glyphs (`Get Started →`), caps (`LOG IN`), or longer
  phrasings (`Reject all and subscribe`), so a control perception clearly *saw*
  fails to resolve. Perception found it; action couldn't name it.
- **`ROLE_MAP` silently drops structural roles** *(high)* — the perception role
  allowlist (`packages/perception/src/from-snapshot.ts`) drops `cell` /
  `columnheader` / `row` / `iframe` / `generic` / `video` with no warning. A
  table-driven UI (Hacker News) loses **28%** of nodes; a consent wall (Guardian)
  **17%**. Iframe-embedded widgets (consent walls, payment frames) are the most
  security-relevant of these blind spots.
- **No "I was blocked / bot-walled" signal** *(medium)* — a bot-block 404 is
  perceived as a normal small page; an agent could act on a dead page.
- **No "main content is canvas/WebGL" signal** *(medium)* — a WebGL canvas is
  a11y-invisible by nature, and Lattice gives no hint to escalate to L3 vision.
- **Egress origin-exact-match blocks legit same-site subresources** *(medium,
  already documented)* — it blocked a site's own `automation.*` subdomain and its
  font/analytics CDNs. Security posture is correct; usability is the cost of the
  origin-level ceiling.
- **Recovery is proven only for the re-render case** *(validation gap)* — the
  bounded re-anchor ladder resolved **10/10** across a re-snapshot, but a hard SPA
  route change / large mutation (ladder rungs 2–3) was not stressed.

These are tracked as the next fix backlog. None is a security regression; the two
`high` items are perception/usability coverage.

## Architecture

A pnpm monorepo of focused packages (13 published + 2 apps):

| Package | Responsibility |
|---|---|
| `@lattice/engine` | CDP adapter over `playwright-core` — isolated contexts, navigation, teardown. The **opt-in dev** engine (`LATTICE_ENGINE=cdp`). |
| `@lattice/engine-adapter` | **Build-on engine (ADR 0002), the DEFAULT:** [agent-browser](https://agent-browser.dev) wrapped behind a narrow semantic port, **internal-only**, with kernel-bypass primitives (`eval`/raw-CDP/file/profile) firewalled. See [SECURITY.md](./SECURITY.md). |
| `@lattice/perception` | Interaction Graph from DOM + Accessibility tree + layout. Stable node identity, fidelity tiers **L0/L1/L2/L3**, deltas. |
| `@lattice/action` | Semantic actions (`navigate`/`act`/`fill`/`select`/`submit`/`extract`/…) over **trusted** input, with engine-owned settling. |
| `@lattice/recipe` | Per-domain **declarative** recipes (capability packs): versioned, applied instead of rediscovering a known flow; resolved against the live IG and run through the **same governed actuator** (a recipe shortcuts perception/planning, **not** gating), with graceful fallback on drift. |
| `@lattice/runtime` | Scheduler + resource governor for N concurrent contexts; ephemeral/persistent topologies; fan-out. |
| `@lattice/kernel` | Security kernel — content tainting, policy classification, capability gating, egress firewall, constitutional floor, audit log. |
| `@lattice/egress-proxy` | App-level egress firewall: a forward proxy agent-browser runs behind (`HTTP_PROXY`), gating browser requests per destination-origin. **Gates HTTP only today** — Chromium doesn't route HTTPS through it ([SECURITY.md](./SECURITY.md) §4c). |
| `@lattice/gateway` | MCP server (stdio **and** Streamable HTTP). Tool groups: `session.*` `perceive.*` `act.*` `extract.*` `capability.*` `vault.*` `policy.*`. |
| `@lattice/observability` | Structured, diffable traces; deterministic replay; metrics; Svod emission. |
| `@lattice/sdk-ts` | Thin TypeScript client. |
| `@lattice/eval` | The eval harness: the governance gate, the economics gate, recovery/cache/recipe evals. The source of every number above. |
| `apps/serve` | The unified process — MCP gateway + control plane on one shared kernel (`lattice serve`). |
| `apps/control-plane` | Human supervision UI (HTTP + SSE): intent input, live session theater, approval inbox, policy editor, replay browser. |
| `apps/demo` | Demo agent + mobile responsive sanity check. |

## Quickstart

See **[QUICKSTART.md](./QUICKSTART.md)** for the full, verified zero-to-first-cycle
path. The short version:

```bash
corepack enable
pnpm install
pnpm -r build
pnpm -r test          # integration tests auto-skip if no browser is found

node apps/serve/dist/main.js
# MCP gateway:   http://0.0.0.0:8765/mcp   (token-gated; auto-generated + printed if unset)
# Control plane: http://127.0.0.1:7900
# Health:        http://localhost:8765/health
```

`lattice serve` **defaults to the build-on (firewalled) engine** where
`eval`/raw-CDP/file are structurally absent; `LATTICE_ENGINE=cdp` is the explicit
dev-only opt-in for the raw-CDP stack. The `/mcp` endpoint is **always**
token-gated — if `LATTICE_MCP_TOKEN`/`LATTICE_CP_TOKEN` are unset, an ephemeral
token is generated and printed at startup (access is never open). Copy
[`.env.example`](./.env.example) to `.env` to configure.

### Self-hosted (Docker)

```bash
docker compose up --build
# Gateway: http://localhost:8765/mcp   Health: http://localhost:8765/health
# Start the HTTP egress proxy — scope the deployment to its origins (18/22 → 20/22):
LATTICE_ALLOWED_ORIGINS="https://app.example.com" docker compose up --build
```

The image defaults to the **build-on (firewalled)** engine, mirroring
`lattice serve` — `eval`/raw-CDP/file are structurally absent. agent-browser
downloads its own Chrome for Testing on first run. `LATTICE_ENGINE=cdp` selects
the legacy raw-CDP engine (no build-on firewall): an explicit, **unsafe** dev-only
override — never in production. A bare `docker compose up` leaves egress
unrestricted (dev default); set `LATTICE_ALLOWED_ORIGINS` to turn on the egress
proxy (18/22 → 20/22 wired). The proxy gates **HTTP** egress; **HTTPS**
sub-resource egress is **not** app-gated today (agent-browser/Chromium doesn't
route HTTPS through it — see [SECURITY.md](./SECURITY.md) §4c).

For **HTTPS** egress, or defense-in-depth on top of the app proxy, run a
**network-layer** egress allowlist (squid/nftables/pf) in front of the process —
the squid/nftables recipe is in [SECURITY.md](./SECURITY.md) §7. This is the
compensating control until app-level HTTPS gating lands.

### Desktop (macOS) — native app

macOS gets a **fully native SwiftUI** control plane + supervisor ([ADR 0003](apps/desktop-macos/README.md)) —
no web, no webview. One app is both the UI **and** the supervisor: launch it and
the whole stack (gateway + agent-browser + egress proxy + Chromium) comes up;
quit and it tears down cleanly (zero orphans). Vault secrets live in the **macOS
Keychain**; human-handoff approvals arrive as **native notifications** with
Approve/Deny.

```
# build (until a notarized release .dmg is published)
pnpm -w build && cd apps/desktop-macos && ./Scripts/make-app.sh
open build/Lattice.app          # menubar shield → first-run egress setup → Control Plane
```
Install (release): open `Lattice.dmg`, drag **Lattice** to **Applications**, launch,
and complete the **first-run allowlist** (the origins the agent may reach).

**Desktop Gate 2 = 20/22.** Unlike `docker compose up` (egress proxy off by
default → 18/22), the desktop ships the **egress firewall ON by default**, scoped
by that first-run allowlist — the secure config is the default via setup UX. The
proxy gates **HTTP** egress; on desktop it is the **sole** egress layer (no squid
behind it), so the **2 HTTPS `egress-exfil` vectors stay unwired** — desktop is
**20/22, not 20/20**. (If you handle untrusted HTTPS-exfil-sensitive workloads on
desktop, that gap is real until app-level HTTPS gating lands.)
Building/signing/notarizing the `.dmg`: see
[apps/desktop-macos/NOTARIZATION.md](apps/desktop-macos/NOTARIZATION.md).

**Windows / Linux** stay **console-only** — no new code. Run the stack via
`docker compose up` or `node apps/serve/dist/main.js` (above) and drive it from
Claude Code / Desktop over the localhost MCP endpoint. The native app is a
macOS-exclusive face on the **same** backend.

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
devices, budget, audit. It is **tiered**:

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
the device can verify origin before showing a form.

### Fidelity tiers

- **L0** — structural summary (counts, title, url). Cheapest.
- **L1** — the Interaction Graph: roles, labels, state, value, relations, stable IDs. The default; < 5KB for a typical page.
- **L2 / L3** — L1 plus geometry (box model); L3 adds pixels. Request only where pixel-level reasoning is needed.

The L1 payload is **compact** — one `role + label` line per node, addressed by a
stable `NodeId`. The agent acts on the id, never on a serialized node blob, so the
perception cost is the labels, not the structure.

## Security model

The kernel mediates every consequential effect. The full threat model, the five
governance pillars, the Gate-2 narrative (including the **six audit gaps that were
found and fixed test-first**), and the honest ceilings are in
**[SECURITY.md](./SECURITY.md)**. In brief:

- **Content tainting** — perception output is marked tainted (`TaintedStr`) and quarantined; page text cannot be promoted to instruction context (type-level). Prompt-injection in a page does not change behavior.
- **Capability gating** — every action is classified `read`/`benign`/`consequential`/`prohibited` and intercepted **before** it takes effect; `consequential` requires a human grant.
- **Egress firewall** — destinations are checked against an allowlist (origin-level; **HTTP-only enforcement on the real path**, HTTPS sub-resource egress not yet app-gated — see the honest scope note above).
- **Constitutional floor** — invariants no `policy_set` may weaken, *by anyone* through the API, even with a valid grant: tainting stays on, floor-prohibited primitives stay prohibited, content-proposed egress stays blocked.
- **Human-grant asymmetry** — operator writes need a single-use token minted only by the human control plane; the agent cannot self-authorize, only request a handoff. `persona_import` is human-UI-only.

These are covered by mandatory negative tests in
`packages/gateway/src/operator.test.ts`, `packages/kernel/src/operator.test.ts`,
`packages/action/src/governed-actuator.test.ts`, and the firewall tests.

## Observability

Every session produces a structured, diffable trace (perception snapshots,
actions, deltas, grants, network) emitted as JSONL and to the project's Svod
trace store. Traces **replay deterministically**; replaying against a changed
site surfaces the exact diff. PII is redacted before persistence by default.

## Status

P0–P3 of the prototype are complete: an external agent drives a full
perceive→act→extract cycle over MCP; the governance and economics gates pass and
are pinned in CI; the recipe library ships; traces land in Svod; the self-hosted
Docker gateway runs. The engine layer runs on **agent-browser** (ADR 0002) as the
default, firewalled, internal-only substrate, with a CDP path kept as a dev
opt-in. A native Chromium fork is a deliberate, human-gated future step, not
started automatically.

The **macOS desktop app** (ADR 0003) is functionally complete: native control
plane (theater · approvals · policy · replay timeline · personas/vault),
supervisor with zero-orphan teardown, Vault→Keychain, handoff→native
notifications, and the egress firewall on by default (desktop Gate 2 = **20/22** —
HTTP egress gated; HTTPS sub-resource egress not yet app-gated, a documented
limitation). It builds to a dev-signed `.app` + `.dmg`; a notarized release awaits
a Developer ID signature.

## License & attribution

Apache-2.0 (see [LICENSE](./LICENSE)). Builds on
[agent-browser](https://agent-browser.dev) (Apache-2.0, pinned 0.31.0) and
`playwright-core` (Apache-2.0), used unmodified — see [NOTICE](./NOTICE).
agent-browser is a **parity reference** in the eval, never directly reachable by
an agent; its kernel-bypass primitives are firewalled (see [SECURITY.md](./SECURITY.md)).
