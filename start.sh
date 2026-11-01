#!/usr/bin/env sh
#
# Start the MCP server (127.0.0.1:8787) and a Cloudflare Quick Tunnel for it.
# The phone bridge on port 8766 is never exposed.
#
#   sh start.sh
#
# Set PHONE_MCP_TUNNEL=0 to run locally only.
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')

# shellcheck source=scripts/common.sh
. "$SELF_DIR/scripts/common.sh"

REPO_DIR="$SELF_DIR"
load_config
ensure_dirs
require_node

[ -s "$TOKEN_FILE" ] || fail "no bearer token at $TOKEN_FILE - run install.sh first"

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
fi

if health_ok "http://127.0.0.1:$MCP_PORT/health"; then
  if pid_alive "$MCP_PID_FILE"; then
    ok "MCP server already running (pid $(cat "$MCP_PID_FILE"))"
  else
    warn "port $MCP_PORT already answers /health but no pid file was found; re-using that server"
  fi
else
  if pid_alive "$MCP_PID_FILE"; then
    warn "stale pid file found; restarting the MCP server"
    kill "$(cat "$MCP_PID_FILE")" 2>/dev/null || true
    rm -f "$MCP_PID_FILE"
    sleep 1
  fi

  say "Starting the MCP server on $MCP_HOST:$MCP_PORT"
  cd "$REPO_DIR"
  nohup "$NODE_BIN" "$REPO_DIR/src/main.js" >>"$MCP_LOG" 2>&1 &
  echo $! >"$MCP_PID_FILE"

  i=0
  while [ "$i" -lt 40 ]; do
    health_ok "http://127.0.0.1:$MCP_PORT/health" && break
    pid_alive "$MCP_PID_FILE" || break
    i=$((i + 1))
    sleep 1
  done

  if health_ok "http://127.0.0.1:$MCP_PORT/health"; then
    ok "MCP server is healthy (pid $(cat "$MCP_PID_FILE"))"
  else
    rm -f "$MCP_PID_FILE"
    printf '\n--- last log lines (%s) ---\n' "$MCP_LOG" >&2
    tail -n 20 "$MCP_LOG" 2>/dev/null >&2 || true
    fail "the MCP server did not become healthy; see $MCP_LOG"
  fi
fi

start_tunnel() {
  if [ "${PHONE_MCP_TUNNEL:-1}" = "0" ]; then
    warn "tunnel disabled by PHONE_MCP_TUNNEL=0; only the local endpoint is available"
    return 0
  fi

  if pid_alive "$TUNNEL_PID_FILE"; then
    if [ -s "$TUNNEL_URL_FILE" ]; then
      ok "tunnel already running: $(cat "$TUNNEL_URL_FILE")"
      return 0
    fi
    warn "tunnel process is alive but no URL was recorded yet; restarting it"
    kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    sleep 1
    rm -f "$TUNNEL_PID_FILE"
  fi

  cf=$(cloudflared_bin) || fail "cloudflared is not installed - run install.sh (or set PHONE_MCP_TUNNEL=0)"

  rm -f "$TUNNEL_URL_FILE"
  : >"$TUNNEL_LOG"
  : >"$TUNNEL_CONSOLE_LOG"

  say "Starting a Cloudflare Quick Tunnel for http://127.0.0.1:$MCP_PORT"
  say "the phone bridge ($BRIDGE_URL) is local only and is never exposed"
  # The tunnel URL banner is written by the logger in some cloudflared versions
  # and to the console in others, so both streams go to files we can read.
  nohup "$cf" tunnel \
    --url "http://127.0.0.1:$MCP_PORT" \
    --no-autoupdate \
    --protocol "$CLOUDFLARED_PROTOCOL" \
    --logfile "$TUNNEL_LOG" >>"$TUNNEL_CONSOLE_LOG" 2>&1 &
  echo $! >"$TUNNEL_PID_FILE"

  i=0
  public_url=""
  while [ "$i" -lt 45 ]; do
    public_url=$(sed -n 's|.*\(https://[a-z0-9-]*\.trycloudflare\.com\).*|\1|p' \
      "$TUNNEL_LOG" "$TUNNEL_CONSOLE_LOG" 2>/dev/null | tail -n 1 || true)
    [ -n "$public_url" ] && break
    pid_alive "$TUNNEL_PID_FILE" || break
    i=$((i + 1))
    sleep 1
  done

  if [ -z "$public_url" ]; then
    printf '\n--- last tunnel log lines (%s) ---\n' "$TUNNEL_LOG" >&2
    tail -n 20 "$TUNNEL_LOG" 2>/dev/null >&2 || true
    tail -n 20 "$TUNNEL_CONSOLE_LOG" 2>/dev/null >&2 || true
    fail "cloudflared did not report a trycloudflare.com URL; see $TUNNEL_LOG and $TUNNEL_CONSOLE_LOG"
  fi

  printf '%s\n' "$public_url" >"$TUNNEL_URL_FILE"
  ok "public tunnel: $public_url"
  return 0
}

start_tunnel

public_url=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)
token=$(print_token)

printf '\n'
say "Ready."

printf '  local MCP endpoint  : http://127.0.0.1:%s/mcp\n' "$MCP_PORT"
if [ -n "$public_url" ]; then
  printf '  public MCP endpoint : %s/mcp\n' "$public_url"
fi
printf '  bearer token        : %s\n' "$token"
printf '\n'
printf 'Add both values in FreeMilk: Settings > Integrations > Add MCP server\n'
printf '(Streamable HTTP transport).\n'
printf '\n'
if [ -n "$public_url" ]; then
  warn "Quick Tunnel URLs change every time cloudflared restarts: re-run start.sh and update the URL in FreeMilk."
fi
