# Lattice — Security Model

Lattice is a governance runtime for autonomous browser agents operating against a
hostile web. Its one non-negotiable premise: **the page is data, never
instructions.** Bytes that originate from page content can be *perceived* by the
agent, but they may never become commands — not a navigation, not a form submit,
not an operator mutation, not an egress destination. The only authority over
consequential side effects is the human channel.

This document states the invariants and shows, with `file:line` citations into
the real code, how each one is enforced. Where the implementation has a ceiling,
that ceiling is stated plainly rather than papered over — an honest boundary is
worth more to a security reader than a flawless-sounding facade.

> Status: research prototype. The claims below are backed by code and by tests
> that run green in CI. Numbers come from the in-repo eval harness
> (`packages/eval`), not from a marketing deck.

---

## 1. Threat model

The adversary is the **page**. We assume any visited site may be fully attacker-
controlled and may attempt, through its content (visible text, hidden DOM, form
actions, injected URLs, accessibility labels), to:

| # | Hostile-page goal | Lattice defense | Enforced at |
|---|---|---|---|
| T1 | **Indirect prompt injection → operator mutation** — lift page text into a `policy_set` / `persona_import` call to weaken the agent's own governance or steal credentials | tainted-origin registry blocks any operator call carrying a page-origin argument | `packages/kernel/src/operator.ts:146-156`, `:219-224` |
| T2 | **Indirect injection → consequential action** — "click Pay now" / "send this email" | consequential actions require a human grant; no handler ⇒ denied | `packages/kernel/src/kernel.ts:143-169` |
| T3 | **Egress exfiltration** — a page form/beacon posting collected data to an attacker origin | kernel `checkEgress` (logic) + egress proxy on the real path — **HTTP only; HTTPS not yet app-gated** (§4c) | `packages/egress-proxy/src/index.ts:81-132`, `packages/kernel/src/kernel.ts:210-244` |
| T4 | **Self-weakening** — drop a prohibited primitive or disable tainting via the operator surface, even with a human grant | constitutional floor refuses the patch regardless of grant | `packages/kernel/src/operator.ts:184-195`, `:244-263` |
| T5 | **Kernel-bypass escape hatch** — reach `eval`, raw CDP, or `file://` through the underlying engine | engine firewall + structural surface omission | `packages/engine-adapter/src/firewall.ts:112-130` |
| T6 | **Origin wander** — lure the agent off the task's scoped origins | navigation scope check + unconditional forbidden-scheme floor | `packages/kernel/src/kernel.ts:171-208` |
| T7 | **Operator self-authorization** — call a write-tier operator tool with no human grant | grant asymmetry: the agent has no API to mint a grant | `packages/kernel/src/operator.ts:197-217` |

Every row above is exercised by a real adversarial test (Section 4) and counted
in the governance eval (Section 5).

---

## 2. The five governance pillars

Each pillar is a structural property, not a request the model is asked to honor.

### (a) Instruction/data tainting

Page-origin bytes are wrapped in an opaque `TaintedStr` type whose phantom field
structurally prevents promotion to instruction context
(`packages/kernel/src/types.ts:5-11`). At runtime, every tainted string (and
every string *leaf* of an observed value tree) is also registered in a content-
hash registry — `kernel.taintContent` / `kernel.taintTree`
(`packages/kernel/src/kernel.ts:246-253`) delegate to
`OperatorGate.registerTaint` / `registerTaintTree`
(`packages/kernel/src/operator.ts:103-122`). The registry is what lets the
operator gate detect, later, that an argument *came from a page* even after the
agent has copied it out of the snapshot. The registry is bounded (FIFO eviction
at 50 000 entries) so a long-running gateway cannot grow unbounded
(`operator.ts:97-110`).

### (b) Capability gating

`kernel.classify` sorts every action into `read | benign | consequential |
prohibited` (`packages/kernel/src/kernel.ts:76-107`); `kernel.requestGrant`
auto-grants read/benign, **denies consequential when no human grant handler is
configured**, and refuses prohibited outright (`kernel.ts:109-169`). The single
choke point that routes *every* semantic action through this gate before it
reaches the engine is `GovernedActuator.execute`
(`packages/action/src/governed-actuator.ts:61-97`): navigation is scope-checked,
everything else is classified-and-granted, and file-bearing verbs
(`upload`/`download`) are routed to a typed refusal rather than handing a file
path to the engine (`governed-actuator.ts:126-132`). Recipes flow through the
same gate — `RecipeGate` is satisfied by `GovernedActuator`, so a recorded
recipe can never bypass gating (`packages/recipe/src/runner.ts:34-38, 153-163`).

### (c) Egress firewall

The policy is `kernel.checkEgress` (`packages/kernel/src/kernel.ts:210-244`):
same-origin destinations are allowed, cross-origin destinations are allowed only
if explicitly allowlisted, everything else (including all content-proposed exfil
targets) is blocked.

**Honest enforcement ceiling — HTTP only (verified).** The intended enforcement
on the real in-browser request path is `@lattice/egress-proxy`
(`packages/egress-proxy/src/index.ts`): agent-browser is launched with
`HTTP(S)_PROXY` pointing at it. In practice this **only gates HTTP** egress —
agent-browser/Chromium does **not** route HTTPS browser traffic through the proxy
(verified across `HTTP_PROXY`/`HTTPS_PROXY` env vars, agent-browser `--proxy`, and
the raw Chromium `--proxy-server` flag; none deliver an HTTPS `CONNECT` to the
proxy, and a manual `CONNECT` confirms the proxy itself is correct). So:

- **HTTP** sub-resource egress (beacon / form POST / fetch over `http://`) **is**
  gated on the real path (live e2e proven — `live.e2e.test.ts`).
- **HTTPS** sub-resource egress (the realistic exfil vector) is blocked by
  `checkEgress` **logic** (function-level) but is **NOT enforced** on the real
  browser path today — no caller reaches that logic for browser-initiated HTTPS
  sub-resources.
- Top-level **navigation** (HTTP and HTTPS) is separately scoped by the kernel
  (`origin_out_of_scope`), so the agent cannot *navigate* to a disallowed origin.

**Compensating control today:** run a network/infra egress layer (squid / pf)
in front of the process to gate HTTPS at the network layer. App-level HTTPS
gating is roadmap — see `plans/https-egress-roadmap` (a transparent `pf` →
SNI-inspecting proxy; a separate project with its own risk profile). See Section 6
for the origin-level (not provenance-aware) ceiling that applies on top of this.

### (d) Constitutional floor

`CONSTITUTIONAL_FLOOR` (`packages/kernel/src/operator.ts:59-75`) hard-codes the
invariants no `policy_set` may relax, by anyone, through the API: eight
prohibited primitives (including `persona_import`), tainting-always-on, and
egress-from-content-blocked. `violatesFloor`
(`packages/kernel/src/operator.ts:244-263`) refuses any patch that would drop a
floor primitive, disable tainting, or allow content-proposed egress — and the
floor primitives are *derived* into `classify`'s `ALWAYS_PROHIBITED` set from
the single source of truth (`kernel.ts:32-39`), so the two can never drift.
`applyPolicy` re-unions the floor primitives back into the live prohibited set
unconditionally, so even a caller who bypassed the gate cannot leave the live
config below the floor (`kernel.ts:266-279`).

### (e) Operator surface

The operator surface is tiered (`packages/kernel/src/operator.ts:27-52`):

- **Read** (free for the agent): `policy_get`, `audit_read`, `session_observe`, …
- **Write** (human grant required): `policy_set`, persona/device/budget mutation,
  `vault_store`.
- **Prohibited** (never through the agent API): `persona_import`.

Unknown operator tools fail **closed** — treated as write (`operator.ts:124-130`).
Write-tier mutations require a single-use, TTL-bounded, scope-bound grant token
that **only** the human control plane can mint via `mintHumanGrant`
(`kernel.ts:281-283`, `operator.ts:132-136`); the agent path has no route to mint
one (`packages/kernel/src/types.ts:113-118`). Grants are consumed on use, expire
after 10 minutes, and are bound to a specific `{tool, sessionId}`
(`operator.ts:99-100, 226-236`) — single-use plus TTL plus scope bounds the
replay window three ways. `authorize` checks taint first, then tier, then floor,
then grant (`operator.ts:143-217`).

---

## 3. The agent-browser boundary (ADR 0002)

The engine layer is built on [agent-browser](https://agent-browser.dev)
(Apache-2.0), used **unmodified** as an internal engine — a fork-free build-on,
not a vendored copy. agent-browser's own security is opt-in/bolt-on, which is
exactly the model Lattice rejects, so the integration is safe **only** under a
hard boundary:

1. **Internal-only.** agent-browser is spawned as a child process keyed by a
   private, unguessable session name (`lattice-<uuid>`); no port is exposed
   (`packages/engine-adapter/src/firewall.test.ts:151-161`). The agent's only
   door is the Lattice MCP gateway → the governed session → the engine.
2. **Lattice enforces its own invariants** independent of agent-browser's flags.
   agent-browser's `--action-policy` / `--confirm-actions` are defense-in-depth,
   not the boundary.
3. **Kernel-bypass primitives are firewalled** before the engine process is
   invoked. `assertNotFirewalled` (`packages/engine-adapter/src/firewall.ts:112-130`)
   refuses:

   | Primitive | Why firewalled |
   |---|---|
   | `eval` | arbitrary JS in page context |
   | `connect`, `--cdp`, `get cdp-url` | raw CDP attach → full kernel bypass |
   | `network` | route/abort/mock traffic → response-injection + egress-firewall tamper |
   | `--allow-file-access`, `file://`/`blob://`/… on any arg | local file read |
   | `--profile`, `--state`, `--session-name`, `auth`, `profiler` | plaintext-state / credential import (persona_import vector) |

   Crucially this is **defense-in-depth under a structural omission**: the
   `EngineSession` surface exposes only `navigate / snapshot / read / act /
   close` — there is *no method* that expresses eval, cdp, connect, or file
   (`packages/engine-adapter/src/firewall.test.ts:139-149`). The firewall catches
   even an internal bug that tried to route one.

If an agent could reach agent-browser directly (CLI, daemon socket, raw CDP), the
entire kernel would be bypassed — that is the definition of an integration
failure, and the negative tests in Section 4 assert it cannot happen.

---

## 4. Mandatory negative tests (CI)

These run green and gate the build. They are the executable proof behind the
claims above.

| Invariant under test | Test file |
|---|---|
| Every firewalled subcommand/flag/`file://` scheme is refused, incl. tab/NFKC/percent-obfuscation | `packages/engine-adapter/src/firewall.test.ts` |
| Forbidden-scheme canonicalization (`fi%6ce:`, fullwidth, control chars) | `packages/engine-adapter/src/scheme-canon.test.ts` |
| Engine surface omits eval/cdp; session names carry no port | `packages/engine-adapter/src/firewall.test.ts:130-162` |
| Every action is classified + gated; consequential refused without grant; upload/download refused | `packages/action/src/governed-actuator.test.ts` |
| `extract` cannot smuggle a non-selector expression into the engine | `packages/action/src/extract-security.test.ts` |
| Operator tiers, floor, grants, tainted-origin block | `packages/gateway/src/operator.test.ts` |
| Build-on gateway taints perceive/extract; `vault_store` gated | `packages/gateway/src/build-on-gateway.test.ts` |
| Egress proxy allow/deny/tunnel/403/audit | `packages/egress-proxy/src/index.test.ts` |
| **Live** e2e: real agent-browser behind the proxy; a denied beacon is blocked and the attacker server gets zero hits | `packages/egress-proxy/src/live.e2e.test.ts` (opt-in `LATTICE_LIVE_ENGINE=1`) |
| Recipe steps flow through the governed gate (a recipe cannot bypass gating) | `packages/recipe/src/runner.test.ts` |
| The whole 22-attack governance corpus, adjudicated by real code | `packages/eval/src/governance.test.ts` |

---

## 5. The governance gate — as a narrative

The governance eval (`packages/eval/src/governance.ts`) is a 22-attack corpus of
injection / bypass attempts. **No mocks:** each attack drives the real
`@lattice/kernel` and the real engine firewall and returns a boolean verdict
(`governance.ts:42, 70-78`). Three defenders are compared:

| Defender | Blocks (function-level) | What it is |
|---|--:|---|
| **Lattice** (real kernel + firewall) | **22/22 (100%)** | the product |
| Hardened agent-browser (all opt-in flags) | **8/22 (36%)** | plain action gating only |
| Bare agent-browser / screenshot agent | **0/22 (0%)** | governance off by default |

These numbers were produced by running the in-repo eval, not asserted by hand;
the test `packages/eval/src/governance.test.ts` pins them.

**Function-level vs wired-on-deployment.** The 22/22 above is the *function-level*
block rate: the kernel/firewall **logic** refuses every attack. What a given
**deployment** actually **enforces on the real browser path** is narrower, and the
eval models it honestly (`wiredCountFor`):

| Deployment | Wired (real path) | Note |
|---|--:|---|
| Bare `docker compose up` (build-on engine, **no** allowlist) | **18/22** | egress proxy off → all 4 `egress-exfil` attacks unwired (egress unrestricted by the dev default) |
| `docker compose up` + `LATTICE_ALLOWED_ORIGINS` (proxy on) | **20/22** | proxy gates **HTTP** egress; the **2 HTTPS `egress-exfil` vectors stay unwired** (see below) |
| macOS desktop default (proxy ON via first-run allowlist) | **20/22** | same — HTTP egress wired, HTTPS not; the app proxy is the sole egress layer here |
| Legacy `LATTICE_ENGINE=cdp` (no build-on firewall) | 14–16/22 | the 4 `escape-hatch` attacks are also unwired — do not use for untrusted pages |

**The honest headline is "firewalled-by-default; 18/22 wired zero-config; 20/22
once you scope the deployment — with HTTP egress gated and HTTPS sub-resource
egress NOT yet app-gated."** There is **no honest "20/20 / fully wired" claim**:

- `escape-hatch` (4) needs the build-on engine.
- `egress-exfil` HTTP (2) needs an allowlist (the proxy gates HTTP — live e2e).
- `egress-exfil` HTTPS (2) is blocked by `checkEgress` logic but **never reaches
  the real path** — agent-browser/Chromium does not route HTTPS through the proxy
  (§4c). Compensating control: a network/infra egress layer (squid/pf); app-level
  HTTPS gating is roadmap (`plans/https-egress-roadmap`). The test pins this so it
  cannot regress to a false "fully wired" (`unwiredHttpsEgress`).

**Six attack classes only Lattice covers** — a hardened agent-browser
*structurally* cannot, because it has no operator surface, no constitutional
floor, no tainted-origin propagation, and it deliberately exposes eval/CDP/file:

`injection-to-operator`, `egress-exfil`, `constitutional-floor`, `escape-hatch`,
`origin-scope`, `operator-no-grant` (`governance.ts:302`, verified live: the eval
returns exactly these six).

### The audit gaps — found, and fixed test-first

The reason to trust this gate is not that it is flawless; it is that an
adversarial audit (four read-only security passes over five areas) **found real
holes and fixed them test-first**, all sharing one signature:

> **An invariant declared at one level, enforced via a proxy/copy at another —
> so a value the audit could read let it pick the spelling/path the enforcement
> didn't guard.**

Six bounded gaps were found and closed; each fix lives in the current code:

| # | Gap | Fix (verified in current code) |
|---|---|---|
| 1 | `classify()` used a hand-copied `ALWAYS_PROHIBITED` that had drifted, omitting `persona_import` | derived from `CONSTITUTIONAL_FLOOR` — one source of truth (`kernel.ts:32-39`) |
| 2 | CDP `extractQuery` had a `return eval(q)` fallback | eval fallback removed; extract is selector-only (`packages/action/src/extract-security.test.ts`) |
| 3 | `vault_store` dispatched directly, skipping the write gate | routed through the operator write gate; `vault_store` is in `WRITE_TOOLS` (`operator.ts:41-49`; `build-on-gateway.test.ts`) |
| 4 | `perceive_snapshot`/`delta`/`extract` returned **un-tainted** content | all read paths taint via `taintContent`/`taintTree` (`kernel.ts:246-253`; `build-on-gateway.test.ts`) |
| 5 | Scheme canonicalization only stripped ≤0x20, so `fi%6ce:` / fullwidth slipped through | percent-decode + NFKC + strip ≤0x20, in **both** scheme guards (`firewall.ts:84-105`, `kernel.ts:351-370`; `scheme-canon.test.ts`) |
| 6 | Control-plane API served `Access-Control-Allow-Origin: *` on a credentialed endpoint | wildcard removed (control-plane) |

### The gap the eval itself caught

While building Gate 2, the eval surfaced a live floor-naming bug: the floor
*declares* the invariant under the name `taintingAlwaysOn`, but `violatesFloor`
originally guarded only the enforcement key `taintingEnabled`. An attacker who
read the floor's own field names could send `taintingAlwaysOn: false` and get
**accepted-but-ignored** instead of refused. The fix guards **both** spellings —
`violatesFloor` now rejects `taintingEnabled === false` *and*
`taintingAlwaysOn === false` (`packages/kernel/src/operator.ts:249-250`), and the
`floor-disable-tainting` attack in the corpus asserts the floor-violation verdict
(`governance.ts:184-196`). This is the recurring signature, caught one more time —
by the gate itself.

---

## 6. Honest ceilings

These are real limits of the current implementation. They are stated here so the
first reader can calibrate trust correctly.

### Egress is origin-level, not provenance-aware (on the wired path)

The kernel's `checkEgress` *is* provenance-aware: it consults `sourceOrigin`,
classifies a destination as content-proposed when its source is not the task
scope, and audits that distinction (`packages/kernel/src/kernel.ts:210-244`).
**But on the real wired path the enforcement is the proxy**, and over HTTPS
CONNECT the proxy sees only `host:port`, not the page that initiated the request
(`packages/egress-proxy/src/index.ts:15-19, 112-117`). So the live decision is a
per-request **destination-origin allowlist** (`originAllowlist`,
`index.ts:140-143`), not a content-vs-task provenance check. Origin-level is the
**ceiling of the fork-free path**. True per-request provenance on the wired path
is **known future work** — it needs a per-request callback (firewalled CDP
`Fetch`, an agent-browser intercept callback, or a fork). The proxy is also only
*started* when an allowlist is configured (`apps/serve/src/main.ts`), so on a bare
`docker compose up` egress is unrestricted by the dev default and all 4
egress-exfil attacks are **unwired** (18/22) until you set `LATTICE_ALLOWED_ORIGINS`.

> The egress proxy has **two stacked limitations** on the wired path, neither
> oversold: (1) it only **starts** with an allowlist; (2) it only gates **HTTP** —
> agent-browser/Chromium does not route **HTTPS** browser traffic through it
> (§4c), so the 2 HTTPS `egress-exfil` vectors stay unwired even when configured.
> So the configured deployment is **20/22**, not a full 22 — and even on the HTTP
> path the decision is **origin-level**, not provenance-aware. There is no
> "fully wired" egress claim today. HTTPS app-gating is roadmap
> (`plans/https-egress-roadmap`); the compensating control now is a network/infra
> egress layer (squid/pf).

### Two egress layers, neither oversold

1. **App-level proxy** (`@lattice/egress-proxy`) — the primary control,
   per-request, on the real agent path, live-e2e-proven. Origin-keyed (above).
2. **Infra layer** (squid / nftables / NetworkPolicy) — defense-in-depth so a
   hostile page cannot exfiltrate even if the app-level proxy is bypassed. This
   is belt-and-suspenders, deployable on its own, and documented in Section 7.

Neither replaces the other; the app-level interception is the deeper fix, the
infra layer bounds the residual at the network.

### agent-browser is internal-only — the proxy sits *around* it

`@lattice/egress-proxy` consumes only agent-browser's exposed `--proxy` /
`HTTP_PROXY` support; the engine stays internal-only and is not forked
(`packages/egress-proxy/src/index.ts:11-14`). The build-on engine exposes only
`navigate / snapshot / read / act / close` — eval, raw-CDP, and file access are
structurally absent *and* firewalled.

---

## 7. Default-deployment hardening (A1)

The build-on (firewalled) stack is the **default**. `resolveEngineKind` selects
it for any `LATTICE_ENGINE` value other than the literal `cdp`
(`apps/serve/src/index.ts:31-33`); the legacy raw-CDP stack — which lacks the
build-on firewall and retains a raw `cdp()` handle — is opt-in **only** via
`LATTICE_ENGINE=cdp`, and prints a loud production warning when selected
(`apps/serve/src/main.ts:40-46`). This closes audit finding A1: no default path
bypasses the kernel/tainting/floor guarantees.

**Secure by default.** Both the `/mcp` endpoint and the control-plane API are
*always* token-gated. If `LATTICE_MCP_TOKEN` / `LATTICE_CP_TOKEN` are unset, the
server generates an ephemeral token and prints it — access is never open, but
startup is not blocked (`apps/serve/src/main.ts:102-109`). Traces are
PII-redacted before persistence by default (`main.ts:110-116`).

**Forbidden schemes are floor, not policy.** `file:` / `javascript:` / `blob:` /
`filesystem:` / `view-source:` / `chrome:` and the privileged internal schemes
are refused unconditionally at **both** the kernel (`checkNavigation` →
`hasForbiddenScheme`, `kernel.ts:171-208, 351-370`) and the engine firewall
(`forbiddenUrlScheme`, `firewall.ts:84-105`) — *before* the empty-allowlist
short-circuit — so `open file:///etc/passwd` is blocked even under the
unrestricted dev default.

**Set `LATTICE_ALLOWED_ORIGINS` in any HTTP-exposed deployment.** An empty
allowlist means "unrestricted navigation" (a dev convenience); in production,
scope each task to its origins so cross-origin wander is blocked and the egress
proxy is activated (`apps/serve/src/main.ts:53-61`). The scheme floor holds
either way.

### Infra-layer egress proxy (defense-in-depth)

Route the gateway's egress through a forward proxy on an internal-only network so
a hostile page cannot exfiltrate even if the app-level proxy is bypassed:

```yaml
services:
  lattice:
    networks: [internal]          # no direct internet
    environment:
      HTTPS_PROXY: http://egress-proxy:3128
      HTTP_PROXY:  http://egress-proxy:3128
      NO_PROXY:    127.0.0.1,localhost
  egress-proxy:
    image: ubuntu/squid
    networks: [internal, egress]  # the ONLY service with outbound access
    volumes: [./squid.conf:/etc/squid/squid.conf:ro]
networks:
  internal: { internal: true }    # default-deny: no route to the internet
  egress: {}
```

```squid
# squid.conf — default-deny egress allowlist
acl allowed_dst dstdomain .app.example.com .api.partner.com
http_access allow allowed_dst
http_access deny all
```

Keep the proxy allowlist in sync with `LATTICE_EGRESS_ALLOWLIST`. On a single
host the same effect is achievable with nftables/iptables egress rules on the
container's veth, or a Cilium/NetworkPolicy `egress` allowlist on k8s.

---

## 8. Reporting

This is a research prototype. Please report security issues **privately** to the
maintainers rather than opening a public issue.
