#!/usr/bin/env bash
#
# Assemble Lattice.app from the SwiftPM build product.
#
# Usage: Scripts/make-app.sh [release|debug]
#
# Produces build/Lattice.app — a menubar-only bundle. Embedded backend binaries
# (D1) land in Contents/Resources; code signing / notarization is D7 (the user
# supplies the Developer ID — this script only dev-signs ad-hoc).
set -euo pipefail

CONFIG="${1:-release}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP="build/Lattice.app"
CONTENTS="$APP/Contents"

echo "==> swift build -c $CONFIG"
swift build -c "$CONFIG"

BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)"

# Compile + stage the backend (gateway/control-plane + agent-browser engine).
# Skip with LATTICE_SKIP_BACKEND=1 for fast UI-only iteration.
if [ "${LATTICE_SKIP_BACKEND:-0}" != "1" ]; then
  echo "==> building backend (bun single-binary)"
  "$ROOT/Scripts/build-backend.sh"
fi

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN_PATH/Lattice" "$CONTENTS/MacOS/Lattice"
cp Info.plist "$CONTENTS/Info.plist"
# App icon (Finder/About) — referenced by CFBundleIconFile=AppIcon. Regenerate
# with `swift Scripts/make-icon.swift Signing` if missing.
[ -f Signing/AppIcon.icns ] && cp Signing/AppIcon.icns "$CONTENTS/Resources/AppIcon.icns"

if [ -d "$ROOT/build/backend" ]; then
  echo "==> embedding backend → Contents/Resources/backend"
  cp -R "$ROOT/build/backend" "$CONTENTS/Resources/backend"
fi

# Ad-hoc dev signature so the bundle launches locally. Developer ID signing +
# notarization is D7 and requires the user's identity.
echo "==> ad-hoc codesign (dev)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
  echo "    (codesign skipped — not fatal for local dev runs)"

echo "==> done: $APP"
