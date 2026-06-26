# Architecture — Close P0–P1 gaps

## LatticeCore (new — `packages/gateway/src/core.ts`)

Holds the shared, single-instance state both faces use:

```
LatticeCore
├─ kernel: SecurityKernel              (policy/grant/audit/taint/operator)
├─ scheduler: Scheduler                (S4 governor — budget, warm pool)
├─ vault: Vault                        (encrypted, persisted)
├─ operatorStore: OperatorStore        (policy/persona/device/budget)
├─ handoff: HandoffManager             (device fan-out, signed input)
├─ grantInbox: OperatorGrantInbox      (UI approves → mints on `kernel`)
├─ sessions: SessionRegistry           (drives scheduler; emits lifecycle)
├─ traces: TraceStore                  (in-mem ring + Svod emit on finish)
└─ events: EventBus                    (session/trace/approval → SSE)
```

GatewayServer takes a `LatticeCore`; ControlPlaneServer takes the same instance. `lattice serve` (new `packages/gateway/src/serve.ts`) boots one core and both servers.

## Data flow

1. **Live theater**: `SessionRegistry.create/destroy` and each `perceive/act` → `core.events.emit({type:"session",...})` → ControlPlaneServer SSE `/events` + `/sessions`.
2. **Operator-write grant**: agent calls `policy_set` w/o grant → gateway raises `core.grantInbox.request(scope)` + emits approval event → UI `POST /operator-grants/:id/approve` → `kernel.mintHumanGrant` → token returned → agent retries.
3. **Handoff**: `session_handoff` → `core.handoff.raise` fan-out → UI/PWA `/handoff/:id` page verifies signature → `POST /handoff/:id/claim` then `/approve` or `/input` → `submitInput` writes Vault→form.
4. **Trace**: `SessionRegistry.destroy` → recorder.finish() → `core.traces.add` → `emitToSvod(trace, writer)` (file writer default, MCP when injected) → ControlPlane replay list/viewer.

## Multi-session transport

`startHttp` keeps `Map<sessionId, StreamableHTTPServerTransport>`. On `initialize` (no `mcp-session-id`): create transport with `sessionIdGenerator`, connect a fresh `Server` clone? — no: the MCP `Server` can host multiple transports. Create one transport per session, route by header, clean up on DELETE/`onclose`.

## Scheduler on the path

`SessionRegistry.create(topology)` → `scheduler.acquire({topology, budget})` returns a context from the warm pool or a fresh one, counted against the governor. `persistent` topology → context keyed by persona; cookies/storage restored via `scheduler.snapshotContext/restoreContext` (already implemented) on reacquire.

## Vault at rest

`Vault(keyHex, path)`: AES-256-GCM per entry (random IV), persisted as JSON `{iv, ct, tag}` to `path`. Key from `LATTICE_VAULT_KEY` (32-byte hex) or generated + warned. `getPassword` decrypts in-memory only.

## Origin scoping

`kernel.checkNavigation(targetUrl, taskOrigins)` → allowed iff origin ∈ allowedOrigins (empty = unrestricted, for dev). ActionEngine consults it before `navigate`; blocked → typed `origin_out_of_scope`.

## perceive_subscribe

`perceive_subscribe(sessionId, intervalMs)` registers a poller in `session.subscriptions`; pushes deltas as MCP `notifications/message` over the session's transport. `perceive_unsubscribe` clears it.

## Capability registry

`CapabilityRegistry`: `Map<origin, {nativeMCP, lastSeen, actions}>`. `capability_check` populates it; `act_execute` consults — if `nativeMCP`, route via `navigator.modelContext` fast path (probe-and-call), else semantic fallback.

## Test surfaces

Unit + in-process MCP/HTTP (no browser) for: transport pool, core wiring, grant-inbox HTTP round-trip, vault crypto, origin scoping, capability registry, handoff page signature verify. Browser-gated for: persistent persona reuse, perceive_subscribe stream, scheduler acquire.
