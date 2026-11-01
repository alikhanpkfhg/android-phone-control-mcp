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

# A hostname is not evidence that the tunnel works: the Cloudflare edge keeps
# answering for a trycloudflare hostname whose cloudflared process is gone, with
# HTTP 530. Only a 401 from POST /mcp proves the edge reached this server.
verify_public_url() {
  "$NODE_BIN" "$REPO_DIR/scripts/verify-tunnel.js" "$1" >/dev/null 2>&1
}

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
    # Drop any URL left over from an earlier run, so it is never advertised.
    rm -f "$TUNNEL_URL_FILE"
    return 0
  fi

  existing=""
  [ -s "$TUNNEL_URL_FILE" ] && existing=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)

  if pid_alive "$TUNNEL_PID_FILE"; then
    if [ -n "$existing" ] && verify_public_url "$existing"; then
      ok "tunnel already running and verified: $existing"
      return 0
    fi
    warn "the recorded tunnel does not answer, so nothing behind that hostname is alive; restarting cloudflared"
    kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    sleep 2
    kill -9 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    rm -f "$TUNNEL_PID_FILE"
  fi
  rm -f "$TUNNEL_URL_FILE"

  cf=$(cloudflared_bin) || fail "cloudflared is not installed - run install.sh (or set PHONE_MCP_TUNNEL=0)"

  # Both logs are truncated so every hostname read below belongs to this run.
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

  # Wait for the edge to actually register a connector for that hostname.
  i=0
  while [ "$i" -lt 45 ]; do
    grep -q 'Registered tunnel connection' "$TUNNEL_LOG" 2>/dev/null && break
    pid_alive "$TUNNEL_PID_FILE" || break
    i=$((i + 1))
    sleep 1
  done

  # A tunnel can register and die a second later. Without this settle check the
  # dead hostname gets written to tunnel-url.txt and looks healthy forever.
  sleep 2
  if ! pid_alive "$TUNNEL_PID_FILE"; then
    printf '\n--- last tunnel log lines (%s) ---\n' "$TUNNEL_LOG" >&2
    tail -n 20 "$TUNNEL_LOG" 2>/dev/null >&2 || true
    fail "cloudflared exited right after reporting a hostname (usually quick-tunnel rate limiting: wait a minute, then start.sh once)"
  fi

  say "Verifying the public endpoint"
  verified=0
  i=0
  while [ "$i" -lt 8 ]; do
    if verify_public_url "$public_url"; then
      verified=1
      break
    fi
    pid_alive "$TUNNEL_PID_FILE" || break
    i=$((i + 1))
    sleep 3
  done

  if [ "$verified" -ne 1 ]; then
    "$NODE_BIN" "$REPO_DIR/scripts/verify-tunnel.js" "$public_url" >&2 || true
    printf '\n--- last tunnel log lines (%s) ---\n' "$TUNNEL_LOG" >&2
    tail -n 20 "$TUNNEL_LOG" 2>/dev/null >&2 || true
    fail "the tunnel did not serve this server; not recording $public_url as usable"
  fi

  printf '%s\n' "$public_url" >"$TUNNEL_URL_FILE"
  ok "public tunnel: $public_url (verified)"
  return 0
}

start_tunnel

public_url=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)

printf '\n'
say "Ready."

printf '  local MCP endpoint  : http://127.0.0.1:%s/mcp\n' "$MCP_PORT"
if [ -n "$public_url" ]; then
  printf '  public MCP endpoint : %s/mcp\n' "$public_url"
  printf '  tunnel status       : verified (refuses anonymous requests)\n'
fi
printf '  bearer token        : %s\n' "$(print_token)"
printf '\n'
printf 'Add the endpoint and the token in FreeMilk: Settings > Integrations >\n'
printf 'Add MCP server (Streamable HTTP transport).\n'
printf '\n'
printf 'Full paste-able report: sh %s/report.sh\n' "$REPO_DIR"
printf '\n'
if [ -n "$public_url" ]; then
  warn "Quick Tunnel URLs change every time cloudflared restarts: re-run start.sh and update the URL in FreeMilk."
fi
