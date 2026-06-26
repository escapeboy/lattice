# Lattice — Security Model

Lattice runs autonomous agents against a hostile web. The page is **data, never
instructions**, and the only authority over side effects is the human channel.
This document states the invariants and how the build-on engine (ADR 0002) is
kept inside them.

## The constitutional floor (not policy-editable)

Some invariants are hard-wired and cannot be relaxed by anyone through the API —
not an agent, not a human operator. `policy_set` may only move rules toward
*stricter*, or within a predefined safe envelope; an attempt to drop below the
floor is refused with a typed error and audited.

- **Tainting is always on.** Bytes originating from page content carry a taint
  bit through perception and are delivered in a quarantined channel that cannot
  be promoted to instructions.
- **Prohibited primitives stay prohibited:** CAPTCHA solving, account creation,
  ACL/permission changes, transfers, hard deletes, `persona_import`.
- **Egress proposed by page content is blocked** by default; destinations must
  match the task origin or an explicit allowlist.
- **Operator writes require a human grant** minted by the control plane — the
  agent has no route to mint one.

## Operator surface tiers

- **Read** (free for the agent): `policy_get`, `audit_read`, `session_observe`, …
- **Write** (human grant required): `policy_set`, persona/device/budget
  mutations, `vault_store`. The agent may *request* a grant via handoff; it
  cannot self-authorize.
- **Prohibited** (never via the API): `persona_import` — human-initiated only,
  scoped to origins, secrets land in the Vault, never the model.

Operator calls whose argument or trigger originates from **tainted** content are
blocked structurally — injection cannot reach the operator tools.

## The agent-browser boundary (ADR 0002)

The engine layer is built on [agent-browser](https://agent-browser.dev)
(Apache-2.0), used unmodified as an internal engine. agent-browser's own
security is opt-in/bolt-on, which is exactly the model Lattice rejects — so the
integration is safe **only** under a hard boundary:

1. **Internal-only.** agent-browser is spawned as a child process keyed by a
   private, unguessable session name. No port is exposed. The agent's only door
   is the Lattice MCP gateway → the governed `BuildOnSession` → the engine.
2. **Lattice enforces its own invariants** (tainting, gating, egress, the floor)
   independent of agent-browser's flags. agent-browser's `--action-policy` /
   `--confirm-actions` are defense-in-depth, not the boundary.
3. **Kernel-bypass primitives are firewalled** at the Lattice layer, refused
   before the engine process is ever invoked:

   | agent-browser primitive | Why it's firewalled |
   |---|---|
   | `eval` | arbitrary JS in page context (proven live: `eval "1+1"` → `2`) |
   | `connect`, `--cdp`, `get cdp-url` | raw CDP attach → full kernel bypass |
   | `--allow-file-access` | `file://` access to local files |
   | `--profile`, `--state`, `--session-name` | real-profile / plaintext-state import (persona_import vector) |
   | `auth`, `profiler` | credential profiles / local I/O |

   The build-on engine port exposes only `navigate/snapshot/read/act/close` —
   there is **no method** that expresses these primitives. The firewall is
   defense-in-depth under that structural omission. Raw CDP through the
   `BuildOnContext` shim is refused, so the WebMCP capability probe degrades to
   "no fast path" (semantic fallback) rather than exposing a CDP surface.

If an agent could reach agent-browser directly (CLI, daemon socket, raw CDP),
the entire Security Kernel would be bypassed — that is the definition of an
integration failure.

## Mandatory negative tests (CI)

These run green in CI and gate the build:

1. Agent cannot reach the agent-browser daemon/CLI directly (internal-only +
   firewall, refused before spawn).
2. Agent cannot invoke `eval` / raw CDP / file access.
3. Page injection does not change behavior or reach operator tools.
4. `policy_set` cannot drop below the floor; `persona_import` is human-only.
5. A consequential / operator write without a valid human grant is blocked.

See `packages/engine-adapter/src/firewall.test.ts`,
`packages/gateway/src/{operator,build-on-gateway}.test.ts`,
`packages/action/src/governed-actuator.test.ts`.

## Deployment hardening

- **Local-file / sandbox-escaping schemes** (`file:`, `javascript:`, `blob:`,
  `filesystem:`, `view-source:`, `chrome:`) are refused unconditionally at both
  the kernel (`checkNavigation`) and the engine firewall — local file read is
  never an agent primitive, regardless of task policy.
- **Set `LATTICE_ALLOWED_ORIGINS`** in any HTTP-exposed deployment. An empty
  allowlist means "unrestricted navigation" (a dev convenience); in production,
  scope each task to its origins so cross-origin wander is blocked too. (The
  scheme floor above holds either way.)

### Egress firewall — required compensating control (network layer)

The kernel's egress firewall (`checkEgress`, content-provenance aware) is fully
implemented but **not yet wired to the in-browser request path**: doing so needs
network-level request interception in the engine (planned — see the governance
note). Until that lands, the governance eval reports **18/20 wired on the default
deployment**, with the `egress-exfil` class as the one residual. Close it at the
infrastructure layer — this is a real, deployable mitigation **today**:

Run the gateway container behind an **outbound (egress) allowlist proxy** so a
hostile page cannot exfiltrate data to an attacker origin even if it reaches the
browser. The agent network is default-deny; only the task's origins are allowed
out.

**Docker — route the gateway's egress through a forward proxy on an internal-only
network:**

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
host (Hetzner) the same effect is achievable with nftables/iptables egress rules
on the container's veth, or a Cilium/NetworkPolicy `egress` allowlist on k8s.

This bounds the residual to the network layer regardless of in-browser wiring;
the app-level interception (below) is the deeper fix, not a replacement for it.

## Reporting

This is a research prototype. Report security issues privately to the
maintainers rather than opening a public issue.
