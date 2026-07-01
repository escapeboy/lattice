# Lattice

**A governance browser runtime for agents — a firewalled-by-default build-on
stack whose security moat is *measured*, not promised behind an opt-in flag.**

A 22-attack injection/bypass corpus, adjudicated by the **real** kernel and
firewall (no mocks): the kernel **logic** blocks **22/22 (100%)** at the function
level — versus **8/22** for a fully-hardened agent-browser and **0/22** for the
bare engine. What a deployment **enforces on the real browser path** is narrower
and we say so: **18/22 wired zero-config** by the firewalled build-on engine;
setting `LATTICE_ALLOWED_ORIGINS` starts the egress proxy → **22/22**. The proxy
gates **both HTTP and HTTPS** egress — the browser routes HTTPS `CONNECT` through
it via agent-browser's `--proxy` flag (verified live, end-to-end: a denied
destination is refused at the tunnel). The egress decision is **origin-level**
(destination), **not** content-provenance-aware — that finer gate (distinguishing
which page initiated a request to an *allowed* host) needs engine-level request
interception and is roadmap. Numbers come from an in-repo eval, pinned by CI, not
asserted by hand ([`packages/eval`](./packages/eval), [SECURITY.md](./SECURITY.md)).

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
  supervises the whole stack and persists vault secrets in the Keychain. (The
  app-level egress firewall currently ships **off** on desktop — re-enabling it is
  now viable since HTTPS gating works, a pending posture choice.) Windows/Linux
  run console-only.
  See [Desktop (macOS)](#desktop-macos--native-app).

## Differentiators — honest, measured

| Dimension | Number | Against |
|---|---|---|
| **Governance** | kernel logic blocks **22/22** · real-path **18/22 wired zero-config**, **22/22 with `LATTICE_ALLOWED_ORIGINS`** (HTTP **and** HTTPS egress gated by destination origin) | hardened agent-browser **8/22** · bare **0/22** |
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

> **Egress scope (honest).** (1) The proxy is **active only when an allowlist is
> configured** — a bare `docker compose up` leaves egress unrestricted (18/22);
> set `LATTICE_ALLOWED_ORIGINS` to turn it on (→ 22/22). (2) Once on, it gates
> **both HTTP and HTTPS**: the browser is launched with agent-browser's `--proxy`
> flag, so an HTTPS sub-resource arrives at the proxy as a `CONNECT` and a denied
> destination is refused at the tunnel (verified live, end-to-end e2e). The
> earlier "HTTPS can't be proxied" claim was wrong — it came from passing the
> proxy via `HTTP_PROXY` *env* (which Chromium ignores for `CONNECT`) instead of
> the flag. (3) The remaining limit is **provenance**: the decision is
> **origin-level** (destination host), so it stops exfil to a non-allowlisted
> host but cannot tell which page initiated a request to an *allowed* host —
> content-provenance gating needs engine-level request interception (roadmap).
> See [SECURITY.md](./SECURITY.md) §4c, §6.

## Where it breaks

Honesty builds more trust than a flawless facade. We ran the **real** engine +
proxy against **10 live sites outside the eval corpus** (heavy SPA, content,
login form, e-commerce, shadow-DOM, slow/heavy, consent-wall, table-grid list,
WebGL, RTL). All 10 navigated and snapshotted; **no engine crash, no state
corruption, and no egress leak**. The gaps it surfaced — and where they stand now:

- **Exact-label resolution was too strict** → **fixed (0.2.0).** Label matching is
  now normalised (case-fold, decorative-glyph strip) and tolerates trailing
  content, so `Get Started →`, `LOG IN`, `Reject all and subscribe` resolve.
- **`ROLE_MAP` dropped structural roles** → **fixed (0.2.0).** `table`/`cell`/
  `row`/`iframe`/`code`/`article` now surface at **L2** (consent/payment iframes,
  table data, docs code) — L1 token economy unchanged.
- **No bot-wall / canvas signal** → **fixed (0.2.0).** `perceive_snapshot` returns
  a `signals` object: `looksLikeError` (404/captcha/bot-wall) and `contentSparse`
  (recommend L3) so the agent doesn't act on a dead page.
- **Egress origin-exact blocked same-site subresources** → **fixed, opt-in (0.2.0)**
  via `LATTICE_EGRESS_ALLOW_SUBDOMAINS` (never crosses registrable domains).
- **Recovery only proven for re-render** → **logic-validated (0.2.0)** for a hard
  route-change (rung-2 alt-locator); a full live route-change e2e is still open.

Still genuinely open — **engine-data limits, not code we can fix in Lattice:** an
unnamed link can't be targeted by `href` (the agent-browser snapshot doesn't carry
it) and a `<canvas>` can't be precisely counted (`eval` is firewalled). Both need
the engine to surface more, or the native-fork path.

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
| `@lattice/egress-proxy` | App-level egress firewall: a forward proxy the browser runs behind (via agent-browser's `--proxy` flag), gating requests per destination-origin. **Gates both HTTP and HTTPS** (HTTPS via the `CONNECT` tunnel) when an allowlist is configured. |
| `@lattice/gateway` | MCP server (stdio **and** Streamable HTTP). Tools: `session_*` `perceive_*` `act_execute` `extract_query` `capability_*` `vault_*` `policy_*` `session_handoff`. A ready-to-paste agent system prompt: [docs/agent-prompt.md](./docs/agent-prompt.md). |
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
# Start the egress proxy — scope the deployment to its origins (18/22 → 22/22):
LATTICE_ALLOWED_ORIGINS="https://app.example.com" docker compose up --build
```

The image defaults to the **build-on (firewalled)** engine, mirroring
`lattice serve` — `eval`/raw-CDP/file are structurally absent. agent-browser
downloads its own Chrome for Testing on first run. `LATTICE_ENGINE=cdp` selects
the legacy raw-CDP engine (no build-on firewall): an explicit, **unsafe** dev-only
override — never in production. A bare `docker compose up` leaves egress
unrestricted (dev default); set `LATTICE_ALLOWED_ORIGINS` to turn on the egress
proxy (18/22 → **22/22** wired). The proxy gates **both HTTP and HTTPS** egress —
the browser routes HTTPS `CONNECT` through it via agent-browser's `--proxy` flag;
the decision is origin-level (destination), not content-provenance (see
[SECURITY.md](./SECURITY.md) §4c).

For **HTTPS** egress, or defense-in-depth on top of the app proxy, run a
**network-layer** egress allowlist (squid/nftables/pf) in front of the process —
the squid/nftables recipe is in [SECURITY.md](./SECURITY.md) §7. This is the
compensating control until app-level HTTPS gating lands.

### Desktop (macOS) — native app

macOS gets a **fully native SwiftUI** control plane + supervisor ([ADR 0003](apps/desktop-macos/README.md)) —
no web, no webview. One app is both the UI **and** the supervisor: launch it and
the whole stack (gateway + agent-browser + Chromium) comes up; quit and it tears
down cleanly (zero orphans). Vault secrets persist in the **macOS Keychain**;
human-handoff approvals arrive as **native notifications** with Approve/Deny.

Download the notarized **[`Lattice-macOS-0.2.5.dmg`](https://github.com/escapeboy/lattice/releases/latest)**,
open it, drag **Lattice** to **Applications**, and launch. The menubar shield
supervises the stack — left-click opens the Control Plane, right-click the menu;
existing installs auto-update via Sparkle. Or build from source:

```
pnpm -w build && cd apps/desktop-macos && ./Scripts/make-app.sh && open build/Lattice.app
```

**Desktop egress posture.** The app currently ships the app-level egress firewall
**off** (same egress posture as a bare `docker compose up` → 18/22). Re-enabling it
is now viable — HTTPS egress gating works via the `--proxy` flag — and is a pending
posture/UX choice (it needs a scoped allowlist so it doesn't block ordinary
browsing). Top-level navigation is kernel origin-scoped regardless.
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
- **Egress firewall** — destinations are checked against an allowlist (origin-level; **HTTP and HTTPS** enforced on the real path via the browser's `--proxy` tunnel; content-provenance gating is the remaining roadmap item — see the honest scope note above).
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
supervisor with zero-orphan teardown, persistent Vault→Keychain, and
handoff→native notifications. The app-level egress firewall currently ships **off**
on desktop (18/22; re-enabling is now viable since HTTPS gating works — a pending
posture choice). Shipped as a **notarized, Developer-ID-signed** `.dmg` with
Sparkle auto-update ([latest release](https://github.com/escapeboy/lattice/releases/latest)).

## License & attribution

Apache-2.0 (see [LICENSE](./LICENSE)). Builds on
[agent-browser](https://agent-browser.dev) (Apache-2.0, pinned 0.31.0) and
`playwright-core` (Apache-2.0), used unmodified — see [NOTICE](./NOTICE).
agent-browser is a **parity reference** in the eval, never directly reachable by
an agent; its kernel-bypass primitives are firewalled (see [SECURITY.md](./SECURITY.md)).
