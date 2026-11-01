#!/usr/bin/env sh
#
# Show the state of the MCP server, the tunnel and the phone bridge.
#
#   sh status.sh
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')

# shellcheck source=scripts/common.sh
. "$SELF_DIR/scripts/common.sh"

load_config
require_node

printf 'android-phone-control-mcp status\n\n'

if pid_alive "$MCP_PID_FILE"; then
  ok "MCP server: running (pid $(cat "$MCP_PID_FILE"))"
else
  warn "MCP server: not running"
fi

if health_ok "http://127.0.0.1:$MCP_PORT/health"; then
  ok "health: http://127.0.0.1:$MCP_PORT/health responds"
else
  warn "health: nothing answers on port $MCP_PORT"
fi

if pid_alive "$TUNNEL_PID_FILE"; then
  ok "tunnel: running (pid $(cat "$TUNNEL_PID_FILE"))"
else
  warn "tunnel: not running"
fi

if [ -s "$TUNNEL_URL_FILE" ]; then
  printf 'public URL: %s/mcp\n' "$(cat "$TUNNEL_URL_FILE")"
else
  warn "public URL: none recorded yet (Quick Tunnel URLs are generated on start)"
fi

printf '\nphone bridge: %s (local only, never tunneled)\n' "$BRIDGE_URL"
if health_ok "$BRIDGE_URL/health"; then
  ok "bridge: reachable"
else
  warn "bridge: not reachable (phone_screenshot will fall back to adb)"
fi

if command -v adb >/dev/null 2>&1; then
  devices=$(adb devices 2>/dev/null | sed -n '2,4p' | tr '\n' ' ' || true)
  printf 'adb devices: %s\n' "${devices:-none}"
else
  warn "adb: not installed"
fi

printf '\nbearer token: %s\n' "$(print_token)"
[ -f "$TOKEN_FILE" ] && ls -l "$TOKEN_FILE" 2>/dev/null | sed 's/^/             /' || true

printf '\nlast MCP log lines:\n'
tail -n 15 "$MCP_LOG" 2>/dev/null || printf '(no log yet)\n'

printf '\nlast tunnel log lines:\n'
tail -n 10 "$TUNNEL_LOG" 2>/dev/null || printf '(no log yet)\n'
