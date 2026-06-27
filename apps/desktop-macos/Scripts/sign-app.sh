#!/usr/bin/env bash
#
# Sign build/Lattice.app and every embedded executable with the hardened runtime
# + JIT entitlements, inside-out (D7).
#
#   Scripts/sign-app.sh                  # ad-hoc dev signature (default)
#   IDENTITY="Developer ID Application: NAME (TEAMID)" Scripts/sign-app.sh
#
# The agent NEVER handles Developer ID certificates — pass IDENTITY yourself when
# you're ready to produce a notarizable build. Ad-hoc ("-") runs locally but is
# NOT notarizable.
#
# Chromium is NOT bundled — Playwright fetches it to ~/Library/Caches/ms-playwright
# on first run (outside the .app), so it isn't part of this signature.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APP="build/Lattice.app"
ENT="Signing/Lattice.entitlements"
IDENTITY="${IDENTITY:--}"

[ -d "$APP" ] || { echo "ERROR: $APP not found — run make-app.sh first." >&2; exit 1; }

OPTS=(--force --options runtime --entitlements "$ENT" --sign "$IDENTITY")
# Ad-hoc signatures can't carry a secure timestamp; real identities should.
if [ "$IDENTITY" != "-" ]; then OPTS+=(--timestamp); fi

echo "==> signing embedded executables (identity: $IDENTITY)"
# Inside-out: every Mach-O under Resources/backend, then the app itself.
while IFS= read -r -d '' bin; do
  if file "$bin" | grep -q "Mach-O"; then
    echo "    sign $bin"
    codesign "${OPTS[@]}" "$bin"
  fi
done < <(find "$APP/Contents/Resources/backend" -type f -print0)

# Sparkle.framework: sign its helpers/XPC services inside-out. Use the app's
# JIT entitlements only on the framework itself; the nested XPC services and
# helpers keep their OWN entitlements (the Downloader is sandboxed), so preserve
# them rather than overwriting with bun's JIT set.
FW="$APP/Contents/Frameworks/Sparkle.framework"
if [ -d "$FW" ]; then
  echo "==> signing Sparkle.framework (inside-out, preserving helper entitlements)"
  SP=(--force --options runtime --preserve-metadata=entitlements --sign "$IDENTITY")
  [ "$IDENTITY" != "-" ] && SP+=(--timestamp)
  for item in \
    "$FW/Versions/B/XPCServices/Downloader.xpc" \
    "$FW/Versions/B/XPCServices/Installer.xpc" \
    "$FW/Versions/B/Autoupdate" \
    "$FW/Versions/B/Updater.app" \
    "$FW/Versions/B/Sparkle"; do
    [ -e "$item" ] && { echo "    sign $item"; codesign "${SP[@]}" "$item"; }
  done
  FWSIGN=(--force --options runtime --sign "$IDENTITY")
  [ "$IDENTITY" != "-" ] && FWSIGN+=(--timestamp)
  codesign "${FWSIGN[@]}" "$FW"
fi

echo "==> signing $APP"
codesign "${OPTS[@]}" "$APP"

echo "==> verifying"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "==> signed (identity: $IDENTITY)."
if [ "$IDENTITY" = "-" ]; then
  echo "    NOTE: ad-hoc — runs locally but is NOT notarizable. See NOTARIZATION.md."
fi
