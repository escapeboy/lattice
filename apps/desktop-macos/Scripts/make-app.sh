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

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN_PATH/Lattice" "$CONTENTS/MacOS/Lattice"
cp Info.plist "$CONTENTS/Info.plist"

# Ad-hoc dev signature so the bundle launches locally. Developer ID signing +
# notarization is D7 and requires the user's identity.
echo "==> ad-hoc codesign (dev)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
  echo "    (codesign skipped — not fatal for local dev runs)"

echo "==> done: $APP"
