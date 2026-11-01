#!/usr/bin/env sh
#
# Print one paste-able report about this installation.
#
#   sh report.sh
#
# It contains: the version, both endpoints, whether the public tunnel really
# reaches this server, every local protocol check, and whether the phone
# actually answers. The bearer token is deliberately NOT included, so the output
# is safe to paste into a chat or an issue.
set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')

# shellcheck source=scripts/common.sh
. "$SELF_DIR/scripts/common.sh"

load_config
require_node

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SELF_DIR/package.json" 2>/dev/null | head -n 1)
[ -n "$version" ] || version="unknown"

public_url=""
[ -s "$TUNNEL_URL_FILE" ] && public_url=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)

printf '=== android-phone-control-mcp report ===\n'
printf 'version      : %s\n' "$version"
printf 'host os      : %s\n' "$(uname -s 2>/dev/null || printf unknown)"
printf 'node         : %s\n' "$("$NODE_BIN" -v 2>/dev/null || printf unknown)"
printf 'local mcp    : http://%s:%s/mcp\n' "$MCP_HOST" "$MCP_PORT"
if [ -n "$public_url" ]; then
  printf 'public mcp   : %s/mcp\n' "$public_url"
else
  printf 'public mcp   : none (no tunnel recorded)\n'
fi
printf 'bridge       : %s (local only, never tunneled)\n' "$BRIDGE_URL"
printf '\n'

if [ -n "$public_url" ]; then
  printf '--- public tunnel ---\n'
  "$NODE_BIN" "$SELF_DIR/scripts/verify-tunnel.js" "$public_url" || true
  printf '\n'
fi

printf '%s\n' '--- local checks ---'
"$NODE_BIN" "$SELF_DIR/scripts/selftest.js" || true
printf '\n'

printf '=== end report (no bearer token is included) ===\n'
