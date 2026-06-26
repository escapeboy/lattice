# Lattice — macOS desktop shell

Fully native SwiftUI control plane **and** supervisor for the Lattice governance
browser runtime. No web, no webview (per ADR 0003, "macOS native desktop app").

The backend (the 13 TypeScript packages) is **not** modified by this app. The
Swift code talks to it over the existing localhost MCP/HTTP/SSE interface — the
same surface external agents use — and, at runtime, launches and supervises it
as a child process tree ("start the app → the whole stack comes up").

Windows/Linux remain console-only (`docker compose up`); this directory is
macOS-exclusive.

## Layout

```
apps/desktop-macos/
  Package.swift            SwiftPM executable (opens in Xcode; builds via `swift build`)
  Sources/Lattice/         App entry, menubar, and (later) Supervisor / MCPClient / Views
  Resources/               embedded backend binary lands here (D1)
  Info.plist               bundle metadata (LSUIElement — menubar-only)
  Scripts/make-app.sh      assembles build/Lattice.app from the build product
```

## Build & run (local dev)

```bash
cd apps/desktop-macos
swift build                 # compile
./Scripts/make-app.sh        # → build/Lattice.app (ad-hoc dev-signed)
open build/Lattice.app       # menubar icon appears
```

Developer ID signing + notarization (D7) is **not** done here — that requires the
user's signing identity. The script ad-hoc signs only, which is enough to launch
locally.

## Status

This is the macOS desktop workstream (D-series); the step list and acceptance
gates live in the `macos-desktop-plan` design note. D0 (this scaffold) = menubar
app that builds on CI and launches; no functionality yet.
