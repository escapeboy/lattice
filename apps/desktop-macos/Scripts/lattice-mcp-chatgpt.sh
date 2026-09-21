#!/bin/bash
# stdio MCP entrypoint for clients that cannot carry a bearer header themselves
# (ChatGPT.app's bundled Codex). Reads the gateway token from its 0600 file and
# hands it to the bridge, so the token never lands in a config file.
set -euo pipefail

SECRET="$HOME/.config/lattice/mcp-token.secret"
if [ ! -r "$SECRET" ]; then
  echo "lattice-mcp-chatgpt: missing token file $SECRET" >&2
  exit 1
fi

# LATTICE_MCP_URL is left unset unless given, so the bridge follows the desktop
# app's endpoint.json when the app had to fall back to another port.
export LATTICE_AUTH="Bearer $(cat "$SECRET")"

exec /opt/homebrew/bin/node "$(dirname "$0")/lattice-mcp-bridge.mjs"
