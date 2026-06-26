# Lattice — macOS desktop shell

Fully native SwiftUI control plane **and** supervisor for the Lattice governance
browser runtime. No web, no webview (per ADR 0003, "macOS native desktop app").

The backend (the 13 TypeScript packages) is **not** modified by this app. The
Swift code talks to it over the existing localhost MCP/HTTP/SSE interface — the
same surface external agents use — and, at runtime, launches and supervises it
as a child process tree ("start the app → the whole stack comes up").

Windows/Linux remain console-only (`docker compose up`); this directory is
macOS-exclusive.

## What it does

- **Supervisor** — one app is both UI and process manager. Launch → the whole
  stack (gateway + agent-browser + egress proxy + Chromium) comes up; quit →
  it tears the process group down cleanly (zero orphans); a sidecar crash →
  restart with backoff.
- **Native control plane** (no webview) — live session theater (SSE perceive
  deltas), approval inbox (approve / deny), policy editor, replay event timeline,
  personas & vault panels.
- **Native integrations** — Vault encryption key in the **macOS Keychain**;
  human-handoff approvals as **native notifications** with Approve/Deny
  (first-claim-wins); menubar live status.
- **Egress firewall ON by default** via a guided **first-run allowlist** — the
  desktop's secure default (Gate 2 = 20/22; the app proxy is the sole egress layer
  here and gates **HTTP only** — HTTPS sub-resource egress is not yet app-gated,
  see SECURITY.md §4c).

## Layout

```
apps/desktop-macos/
  Package.swift            SwiftPM package — LatticeKit (logic) + Lattice (app)
  Sources/Lattice/         @main App + AppDelegate (lifecycle, signal teardown)
  Sources/LatticeKit/      Supervisor · MCPClient · ControlPlaneClient · Keychain ·
                           HandoffNotifier · DesktopEgress · Views/
  Tests/LatticeKitTests/   supervisor / MCP / control-plane / Keychain / egress
  Signing/Lattice.entitlements   hardened-runtime + JIT entitlements
  Scripts/                 make-app · build-backend · sign-app · make-dmg
  NOTARIZATION.md          operator notarization steps (Developer ID)
```

## Build & run (local dev)

```bash
pnpm -w build                # repo root: produces apps/serve/dist (backend source)
cd apps/desktop-macos
./Scripts/make-app.sh        # swift build + bun backend → build/Lattice.app
open build/Lattice.app       # menubar shield → first-run egress setup → Control Plane
```
`make-app.sh` runs `build-backend.sh` (bun-compiles the backend + stages the
agent-browser engine into `Contents/Resources/backend/`; pinned in `backend/VERSIONS`).
`LATTICE_SKIP_BACKEND=1` skips the backend build for UI-only iteration. Ports
default to 8765/7900; override with `LATTICE_DESKTOP_GATEWAY_PORT` /
`LATTICE_DESKTOP_CP_PORT`.

### Tests
```bash
swift test                                 # always-on (process-group, egress, Keychain)
LATTICE_RUN_BACKEND_TESTS=1 swift test     # + integration (real backend + Chromium)
```

### Package + sign + .dmg
```bash
./Scripts/sign-app.sh        # ad-hoc dev signature (hardened runtime)
./Scripts/make-dmg.sh        # build/Lattice.dmg (drag-to-install)
```
Developer ID signing + notarization is the operator's step — the agent never
handles certificates. See **[NOTARIZATION.md](./NOTARIZATION.md)**.

## Status

D0–D7 complete: supervisor, embedded bun backend, native MCP/SSE client, native
control plane, Keychain + notifications, egress-on-by-default (Gate 2 = 20/22 —
HTTP egress gated, HTTPS not yet app-gated), hardened dev-signed `.app` + `.dmg`.
A **notarized** release awaits a Developer ID
signature (NOTARIZATION.md). Windows/Linux stay console-only — this app is a
macOS-exclusive face on the same backend.
