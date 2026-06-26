#!/usr/bin/env bash
#
# Package build/Lattice.app into a drag-to-install build/Lattice.dmg (D7).
# Run AFTER make-app.sh and sign-app.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APP="build/Lattice.app"
DMG="build/Lattice.dmg"
STAGE="build/dmg-stage"

[ -d "$APP" ] || { echo "ERROR: $APP not found — run make-app.sh first." >&2; exit 1; }

echo "==> staging"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo "==> hdiutil create $DMG"
hdiutil create -volname "Lattice" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "==> done: $DMG ($(/usr/bin/du -h "$DMG" | cut -f1))"
