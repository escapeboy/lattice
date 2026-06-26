# Test plan — Close P0–P1 gaps

Each feature ships with tests; CI green per commit. Browser-gated tests skip when no Chromium.

| # | Feature | Acceptance test |
|---|---|---|
| 1 | Multi-session transport | Two MCP clients each `initialize` → distinct session ids; both list tools; one DELETE doesn't kill the other |
| 2 | LatticeCore | gateway + control-plane built from one core share kernel identity; audit log is the same instance |
| 3 | Live theater | `session_create` then `act` → control-plane `/sessions` shows the session with url+action count; SSE emits a `session` event |
| 4 | Operator-grant HTTP | agent `budget_set` w/o grant → `/operator-grants` lists it → `POST …/approve` → token → retry applies; deny → no token |
| 5 | Scheduler on path | `SessionRegistry` over scheduler: budget exceeded → `acquire` rejects; warm pool reused; `list` counts |
| 6 | Persistent persona | create persistent persona, set a cookie, destroy, re-create same persona → cookie present |
| 7 | Origin scoping | navigate to off-scope origin with non-empty allowedOrigins → `origin_out_of_scope`; in-scope passes; empty = unrestricted |
| 8 | Vault crypto | store→persist→reload from disk with key → password decrypts; file bytes never contain plaintext; wrong key fails |
| 9 | Svod emit | session teardown calls injected writer with a Svod path + markdown containing metrics |
| 10 | perceive_subscribe | subscribe → DOM mutation → a delta notification arrives; unsubscribe stops it |
| 11 | Capability registry | `capability_check` caches per origin; second lookup hits cache; nativeMCP page → fast-path flag |
| 12 | Handoff page | `/handoff/:id` renders only for a valid signature; tampered id/field → refused; `/input` fills via Vault, value not in response/audit |
| 13 | Device OOB | `device_register` returns `pending` + challenge; `/devices/:id/verify` with token → active; unverified device not notified |
| 14 | Replay viewer | `/replay/:traceId` renders a timeline of snapshots vs actions from a stored trace |

## Edge cases
- transport pool: unknown session id header → 404, not crash; cleanup on client disconnect.
- vault: missing key env → generated key + warning, still functional in-process.
- scheduler: persistent context survives N reacquires; ephemeral is torn down.
- origin scoping: subdomains are distinct origins; data: URLs allowed (no origin).
- handoff signature: constant-time compare; expired handoff page → 410.
- Svod emit: writer throws → teardown still completes (best-effort, logged).

## Regression
Full `pnpm -r test` green (163 baseline + new). The 4 operator negative tests and handoff tests must stay green after the core refactor.
