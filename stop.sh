#!/usr/bin/env sh
#
# Stop the MCP server and the Cloudflare Quick Tunnel started by start.sh.
#
#   sh stop.sh
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')

# shellcheck source=scripts/common.sh
. "$SELF_DIR/scripts/common.sh"

load_config
ensure_dirs

stop_pid_file() {
  name=$1
  file=$2

  if pid_alive "$file"; then
    pid=$(cat "$file")
    say "Stopping $name (pid $pid)"
    kill "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 10 ]; do
      kill -0 "$pid" 2>/dev/null || break
      i=$((i + 1))
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "$name did not exit; sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
    ok "$name stopped"
  else
    warn "$name is not running"
  fi

  rm -f "$file"
}

stop_pid_file "cloudflared tunnel" "$TUNNEL_PID_FILE"
stop_pid_file "MCP server" "$MCP_PID_FILE"
rm -f "$TUNNEL_URL_FILE"

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock 2>/dev/null || true
fi

ok "done"
