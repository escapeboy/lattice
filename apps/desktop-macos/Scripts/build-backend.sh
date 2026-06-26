#!/usr/bin/env bash
#
# Compile the Lattice backend (MCP gateway + control plane) into a single
# bun executable and stage it — with the agent-browser native binary — under
# build/backend/. make-app.sh copies build/backend/ into the .app bundle's
# Contents/Resources (D1).
#
# Why externals:
#   - agent-browser  : the engine is a separate NATIVE binary that the backend
#                      spawns; engine-adapter locates it via
#                      require.resolve("agent-browser/package.json"). That can't
#                      resolve inside bun's single-file VFS, so we keep the
#                      package EXTERNAL and ship it on disk next to the binary
#                      (resolves at runtime relative to the executable).
#   - chromium-bidi  : an OPTIONAL playwright-core transport (BiDi). Lattice
#                      drives the native engine over CDP, never BiDi, so this
#                      require is never executed — external-but-absent is fine.
#
# Deterministic: versions are pinned in VERSIONS (bun + agent-browser + target).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
TARGET="${LATTICE_BUN_TARGET:-bun-darwin-arm64}"
OUT="$ROOT/build/backend"
ENTRY="$REPO/apps/serve/dist/main.js"

command -v bun >/dev/null || { echo "bun not found — install bun (see VERSIONS)"; exit 1; }

if [ ! -f "$ENTRY" ]; then
  echo "ERROR: $ENTRY missing. Run \`pnpm build\` at the repo root first." >&2
  exit 1
fi

# Locate the installed agent-browser package (pnpm store).
# engine-adapter is the direct dependent of agent-browser (apps/serve only sees
# it transitively, which pnpm's strict layout hides).
AB_SRC="$(node -e "const{createRequire}=require('module');const r=createRequire('$REPO/packages/engine-adapter/package.json');console.log(require('path').dirname(r.resolve('agent-browser/package.json')))")"
AB_VERSION="$(node -e "console.log(require('$AB_SRC/package.json').version)")"
BUN_VERSION="$(bun --version)"

echo "==> bun $BUN_VERSION → compile ($TARGET)"
rm -rf "$OUT"
mkdir -p "$OUT"
bun build --compile --target="$TARGET" "$ENTRY" \
  --external chromium-bidi --external agent-browser \
  --outfile "$OUT/lattice-backend"

echo "==> staging agent-browser@$AB_VERSION (darwin binaries only)"
AB_DEST="$OUT/node_modules/agent-browser"
mkdir -p "$AB_DEST/bin"
cp "$AB_SRC/package.json" "$AB_DEST/package.json"
cp "$AB_SRC/bin/agent-browser.js" "$AB_DEST/bin/" 2>/dev/null || true
# macOS-only native engine binaries (drop linux/win — ~46MB saved).
for b in agent-browser-darwin-arm64 agent-browser-darwin-x64; do
  cp "$AB_SRC/bin/$b" "$AB_DEST/bin/$b"
  chmod 0755 "$AB_DEST/bin/$b"
done
# Carry the engine's skill assets in case the native binary reads them.
for d in skills skill-data; do
  [ -d "$AB_SRC/$d" ] && cp -R "$AB_SRC/$d" "$AB_DEST/$d"
done

cat > "$OUT/VERSIONS" <<EOF
# Pinned build inputs for the Lattice desktop backend (D1). Deterministic.
bun=$BUN_VERSION
agent-browser=$AB_VERSION
target=$TARGET
EOF

echo "==> staged at $OUT"
cat "$OUT/VERSIONS"
