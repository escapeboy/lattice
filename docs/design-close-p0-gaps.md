# Design — Close P0–P1 gaps (everything except P3)

## Problem

The runtime core (perception, action, kernel, operator surface, handoff logic) is real and tested, but the **last mile** is missing: the two processes (gateway, control-plane) don't talk, the S4 scheduler isn't on the real path, persona contexts aren't persistent, the Vault is plaintext in-memory, delta streaming is poll-only, and the handoff has no human-facing surface. This sprint closes every P0–P1 gap from the honest accounting — explicitly excluding P3 (the Chromium fork).

## Who needs this / what they do today

Teams running agents at scale (dev/ops/QA/RPA). Today they wire screenshot-and-coordinate agents (10–50K tokens/step, flaky). Lattice already gives them semantic perception + a security kernel; this sprint makes it **operable**: a human can watch live sessions, approve operator writes from the UI, intervene on 2FA from a phone, and trust that personas persist and secrets are encrypted.

## Narrowest MVP that compounds

A single `lattice serve` process where: an agent drives sessions over MCP → the human sees them live in the theater → approves consequential/operator actions from one inbox → intervenes via a signed handoff page → and every trace lands in Svod. One kernel, one audit log, two faces.

## Key architectural decision

**Unify around a shared `LatticeCore`.** Both faces (MCP gateway + HTTP/SSE control plane) hold references to ONE kernel, ONE OperatorStore, ONE HandoffManager, ONE in-process trace/session registry. Realizes "UI и MCP споделят един policy/grant/audit слой" (design-operator-surface) directly: UI-minted grants authorize the same kernel the gateway gates against; session lifecycle events populate the theater; traces feed the replay browser. Standalone entrypoints remain for single-face use.

## Scope (in)

Software-implementable + testable:
1. Multi-session HTTP transport (transport pool) — removes single-session limit.
2. Shared `LatticeCore` + `lattice serve` unified process.
3. Live theater + replay wiring (gateway → control-plane).
4. Control-plane HTTP routes: operator-grant inbox, handoff claim/resolve/input.
5. S4 scheduler on the real path (budget/governor/warm-pool).
6. Persistent persona contexts (cookies/storage persist + reuse).
7. Origin scoping enforcement on navigation.
8. Vault: AES-256-GCM at rest + disk persistence.
9. Svod trace auto-emission on teardown (injected writer).
10. `perceive_subscribe` streaming deltas.
11. Capability registry + WebMCP fast-path.
12. Signed handoff page (PWA-style) — value→Vault→form; device OOB verification.
13. Web replay viewer (visual perception-vs-action timeline).

## Scope (out — documented as deployment infra, not faked)

- Headful + Xvfb: real engine launch flag (`headful`, `LATTICE_DISPLAY`); Xvfb itself is ops.
- Residential/mobile proxy per persona: real per-context proxy config; the proxy server is ops.
- WebRTC live-view fallback: mediated-field stays primary; live-view documented as future.
- P3 Chromium fork and everything renderer-level (type-level byte taint, in-process perception): untouched by design.

## Compounding

One process to deploy; one audit log to certify (SOC2/GDPR story); personas that survive restarts; encrypted secrets. Each closed gap removes a "but does it actually…" objection from the dev/ops buyer.

## Delivered (this sprint)

All 13 in-scope items shipped with tests (189 total green):

1. ✅ Multi-session HTTP transport (pool by `mcp-session-id`).
2. ✅ Unified `LatticeCore` + `apps/serve`.
3. ✅ Live theater wiring (gateway observer → control-plane `/sessions` + SSE).
4. ✅ Control-plane operator-grant inbox + handoff routes (claim/approve/input).
5. ✅ S4 scheduler on the real path (governor/budget via `RuntimeSchedulerImpl`).
6. ✅ Persistent persona contexts (snapshot/restore cookies+storage per persona).
7. ✅ Origin scoping on navigation (`kernel.checkNavigation`).
8. ✅ Vault AES-256-GCM at rest + disk persistence.
9. ✅ Svod trace auto-emission on teardown (injected writer; file by default).
10. ✅ `perceive_subscribe` server-push delta streaming.
11. ✅ Capability registry + WebMCP fast-path detection.
12. ✅ Signature-verified handoff page + device OOB verification.
13. ✅ Web replay viewer (perceive-vs-act-vs-gate timeline).

## Documented as deployment infra (real code paths, ops-provisioned)

- **Headful + Xvfb**: the engine already supports `headless:false`; Xvfb is a `DISPLAY` env on the host. Documented, not faked.
- **Residential/mobile proxy per persona**: a per-context proxy is an engine launch arg + a proxy the operator runs; left as deployment config.
- **WebRTC live-view fallback**: the mediated-field path (value→Vault→form) is the implemented primary; full live-view is a future surface.
