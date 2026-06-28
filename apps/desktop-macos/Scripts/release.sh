#!/usr/bin/env bash
#
# End-to-end Lattice macOS release: build → Developer-ID sign → DMG → notarize →
# staple → Sparkle-sign → appcast bump. Orchestrates the individual D1/D7 scripts
# (build-backend, make-app, sign-app, make-dmg) plus Apple notarization so a
# release is one command instead of the ten-step runbook in NOTARIZATION.md.
#
# Usage:
#   Scripts/release.sh <version> [build]
#       <version>  marketing version, e.g. 0.2.0  (CFBundleShortVersionString)
#       [build]    integer build number; default = current CFBundleVersion + 1
#
# Flags (env):
#   IDENTITY="Developer ID Application: NAME (TEAMID)"  signing identity
#                          (default: auto-detect from keychain via sign-app.sh)
#   NOTARY_PROFILE=lattice-notary   notarytool keychain profile (stored once)
#   SKIP_NOTARIZE=1        build + sign + DMG only (local dry build, not shippable)
#   PUBLISH=1             after a green build: commit the appcast bump, push, and
#                          `gh release upload` the DMG. WITHOUT this the script
#                          stops after producing artifacts and PRINTS the publish
#                          commands — releasing is never a side effect of a build.
#
# Prereqs: pnpm, bun, node, xcrun (notarytool/stapler), and — for PUBLISH — gh.
# This script never handles certificates or notarization secrets directly; it
# relies on your keychain identity and the stored `lattice-notary` profile.
set -euo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "ERROR: version required, e.g. Scripts/release.sh 0.2.0" >&2; exit 1; }

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DESKTOP/../.." && pwd)"
NOTARY_PROFILE="${NOTARY_PROFILE:-lattice-notary}"
INFO_PLIST="$DESKTOP/Info.plist"
APPCAST="$REPO/appcast.xml"
APP="$DESKTOP/build/Lattice.app"
DMG="$DESKTOP/build/Lattice.dmg"
DIST_DMG="$DESKTOP/build/Lattice-macOS-$VERSION.dmg"
TAG="desktop-macos-v$VERSION"

pb() { /usr/libexec/PlistBuddy -c "$1" "$INFO_PLIST"; }

CUR_BUILD="$(pb 'Print :CFBundleVersion' 2>/dev/null || echo 0)"
BUILD="${2:-$((CUR_BUILD + 1))}"

echo "==> Lattice release $VERSION (build $BUILD)"
if grep -q "<sparkle:shortVersionString>$VERSION<" "$APPCAST" 2>/dev/null; then
  echo "WARNING: appcast already has an item for $VERSION — a new item will be prepended." >&2
fi

# 1. Stamp the bundle version.
echo "==> stamping Info.plist ($VERSION / $BUILD)"
pb "Set :CFBundleShortVersionString $VERSION"
pb "Set :CFBundleVersion $BUILD"

# 2. Build backend source. `build-backend.sh` (run inside make-app.sh) bundles
#    apps/serve/dist/main.js, so its dist MUST be fresh first — `pnpm -w build`
#    alone has shipped a stale dist before.
echo "==> pnpm -w build"
( cd "$REPO" && pnpm -w build )
echo "==> apps/serve build (refresh dist for the bundler)"
( cd "$REPO/apps/serve" && npm run build )

# 3. Assemble + sign + DMG.
echo "==> make-app"
( cd "$DESKTOP" && ./Scripts/make-app.sh release )
echo "==> sign-app (Developer ID)"
( cd "$DESKTOP" && ./Scripts/sign-app.sh )
codesign --verify --deep --strict "$APP"
echo "==> make-dmg"
( cd "$DESKTOP" && ./Scripts/make-dmg.sh )
cp "$DMG" "$DIST_DMG"

# 4. Notarize + staple (unless skipped).
if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
  echo "==> SKIP_NOTARIZE=1 — leaving $DIST_DMG un-notarized (NOT shippable)"
else
  echo "==> codesign DMG"
  IDENT="${IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | grep -m1 'Developer ID Application' | sed -E 's/.*"(.*)".*/\1/')}"
  [ -n "$IDENT" ] || { echo "ERROR: no Developer ID identity for DMG signing." >&2; exit 1; }
  codesign --force --sign "$IDENT" --timestamp "$DIST_DMG"
  echo "==> notarytool submit (profile: $NOTARY_PROFILE) — waiting…"
  xcrun notarytool submit "$DIST_DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  echo "==> stapler staple"
  xcrun stapler staple "$DIST_DMG"
  spctl -a -t open --context context:primary-signature "$DIST_DMG"
fi

# 5. Sparkle EdDSA signature + length for the appcast enclosure.
echo "==> sign_update (Sparkle EdDSA)"
SIGN_UPDATE="$(find "$DESKTOP/.build" -name sign_update -type f 2>/dev/null | head -1 || true)"
[ -n "$SIGN_UPDATE" ] || { echo "ERROR: sign_update not found — run 'swift build' once to fetch Sparkle." >&2; exit 1; }
SIG_LINE="$("$SIGN_UPDATE" "$DIST_DMG")"   # → sparkle:edSignature="…"[ length="…"]
LENGTH="$(/usr/bin/stat -f%z "$DIST_DMG")"
# Newer sign_update already emits length="…"; only add it if missing so the
# enclosure never carries a duplicate length attribute.
case "$SIG_LINE" in
  *length=*) ENCLOSURE_ATTRS="$SIG_LINE" ;;
  *)         ENCLOSURE_ATTRS="$SIG_LINE length=\"$LENGTH\"" ;;
esac
echo "    $ENCLOSURE_ATTRS"

# 6. Prepend a fresh appcast item (newest-first; Sparkle picks the latest).
echo "==> updating appcast.xml"
PUBDATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
ENCLOSURE_URL="https://github.com/escapeboy/lattice/releases/download/$TAG/Lattice-macOS-$VERSION.dmg"
ITEM=$(cat <<EOF
    <item>
      <title>Version $VERSION</title>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[<ul><li>See the GitHub release notes for $TAG.</li></ul>]]></description>
      <pubDate>$PUBDATE</pubDate>
      <enclosure url="$ENCLOSURE_URL" $ENCLOSURE_ATTRS type="application/octet-stream" />
    </item>
EOF
)
# Insert before the first existing <item>, else before </channel>.
ITEM="$ITEM" awk '
  !done && /^[[:space:]]*<item>/ { print ENVIRON["ITEM"]; done=1 }
  !done && /<\/channel>/         { print ENVIRON["ITEM"]; done=1 }
  { print }
' "$APPCAST" > "$APPCAST.tmp" && mv "$APPCAST.tmp" "$APPCAST"

echo ""
echo "==> artifacts ready:"
echo "    DMG:     $DIST_DMG ($(/usr/bin/du -h "$DIST_DMG" | cut -f1))"
echo "    appcast: $APPCAST (item for $VERSION prepended)"

# 7. Publish — ONLY with PUBLISH=1. Otherwise print the commands and stop.
if [ "${PUBLISH:-0}" = "1" ]; then
  echo "==> PUBLISH=1 — creating GitHub release + pushing appcast"
  ( cd "$REPO" && gh release create "$TAG" "$DIST_DMG" \
      --title "Lattice macOS $VERSION" --notes "Lattice for macOS $VERSION." --prerelease 2>/dev/null \
    || gh release upload "$TAG" "$DIST_DMG" --clobber )
  ( cd "$REPO" && git add appcast.xml apps/desktop-macos/Info.plist \
    && git commit -m "release(desktop): macOS $VERSION (build $BUILD)" \
    && git push )
  echo "==> published $TAG and pushed appcast."
else
  echo ""
  echo "==> build complete. To PUBLISH, run with PUBLISH=1, or manually:"
  echo "    gh release create $TAG \"$DIST_DMG\" --title \"Lattice macOS $VERSION\" --prerelease"
  echo "    git add appcast.xml apps/desktop-macos/Info.plist"
  echo "    git commit -m \"release(desktop): macOS $VERSION (build $BUILD)\" && git push"
fi
