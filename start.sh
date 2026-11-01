#!/usr/bin/env sh
#
# Start the MCP server (127.0.0.1:8787) and a tunnel for it.
#
#   sh start.sh
#
# The provider comes from PHONE_MCP_TUNNEL_PROVIDER:
#   quick (default) Cloudflare Quick Tunnel. No account needed, but the hostname
#                   is new on every restart and there is no uptime promise.
#   ngrok           ngrok free plan. One dev domain per account that does NOT
#                   change when the agent restarts, so the MCP client keeps
#                   working across restarts.
#
# The phone bridge on port 8766 is never exposed.
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

# A hostname is not evidence that the tunnel works: the edge keeps answering for
# a hostname whose tunnel process is gone, with HTTP 530 (Cloudflare) or a 404
# from the agent's host. Only a 401 from POST /mcp proves the public URL reached
# this server with the bearer gate intact.
verify_public_url() {
  "$NODE_BIN" "$REPO_DIR/scripts/verify-tunnel.js" "$1" >/dev/null 2>&1
}

# cloudflared writes everything to --logfile and nothing to stdout, while ngrok
# writes to stdout only. Printing both is the difference between a useful error
# and a blank one.
dump_tunnel_logs() {
  printf '\n--- last lines of %s ---\n' "$TUNNEL_LOG" >&2
  tail -n 20 "$TUNNEL_LOG" 2>/dev/null >&2 || true
  printf '\n--- last lines of %s ---\n' "$TUNNEL_CONSOLE_LOG" >&2
  tail -n 20 "$TUNNEL_CONSOLE_LOG" 2>/dev/null >&2 || true
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

launch_quick() {
  cf=$(cloudflared_bin) || fail "cloudflared is not installed - run install.sh (or set PHONE_MCP_TUNNEL=0)"

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
}

launch_ngrok() {
  ng=$(ngrok_bin) || fail "ngrok is not installed. Install it (pkg install ngrok, or download it from https://dashboard.ngrok.com/get-started/setup) and run: ngrok config add-authtoken <your-authtoken>"

  say "Starting an ngrok tunnel for http://127.0.0.1:$MCP_PORT"
  say "the phone bridge ($BRIDGE_URL) is local only and is never exposed"
  nohup "$ng" http "$MCP_PORT" --log=stdout --log-format=json >>"$TUNNEL_CONSOLE_LOG" 2>&1 &
  echo $! >"$TUNNEL_PID_FILE"
}

read_tunnel_url() {
  case "$TUNNEL_PROVIDER" in
    ngrok)
      "$NODE_BIN" "$REPO_DIR/scripts/tunnel-url.js" ngrok "$TUNNEL_CONSOLE_LOG" 2>/dev/null || true
      ;;
    *)
      "$NODE_BIN" "$REPO_DIR/scripts/tunnel-url.js" quick "$TUNNEL_LOG" "$TUNNEL_CONSOLE_LOG" 2>/dev/null || true
      ;;
  esac
}

start_tunnel() {
  if [ "${PHONE_MCP_TUNNEL:-1}" = "0" ]; then
    warn "tunnel disabled by PHONE_MCP_TUNNEL=0; only the local endpoint is available"
    # Drop any URL left over from an earlier run, so it is never advertised.
    rm -f "$TUNNEL_URL_FILE"
    return 0
  fi

  case "$TUNNEL_PROVIDER" in
    quick | ngrok) ;;
    *) fail "unknown PHONE_MCP_TUNNEL_PROVIDER \"$TUNNEL_PROVIDER\" (use quick or ngrok)" ;;
  esac

  existing=""
  if [ -s "$TUNNEL_URL_FILE" ]; then
    existing=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)
  fi

  if pid_alive "$TUNNEL_PID_FILE"; then
    if [ -n "$existing" ] && verify_public_url "$existing"; then
      ok "tunnel already running and verified: $existing"
      return 0
    fi
    warn "the recorded tunnel does not answer, so nothing behind that hostname is alive; restarting the agent"
    kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    sleep 2
    kill -9 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    rm -f "$TUNNEL_PID_FILE"
  fi
  rm -f "$TUNNEL_URL_FILE"

  # Truncate first, so every URL read below belongs to this run.
  : >"$TUNNEL_LOG"
  : >"$TUNNEL_CONSOLE_LOG"

  # A stray agent left over from a manual run keeps a claim on the same ngrok dev
  # domain (and on the local web interface port), and the managed agent then
  # dies before writing a single log line, which looks like a silent failure.
  case "$TUNNEL_PROVIDER" in
    ngrok)
      pkill -f 'ngrok http' 2>/dev/null || true
      ;;
    *)
      pkill -f 'cloudflared tunnel' 2>/dev/null || true
      ;;
  esac
  sleep 1

  case "$TUNNEL_PROVIDER" in
    ngrok) launch_ngrok ;;
    *) launch_quick ;;
  esac

  i=0
  public_url=""
  while [ "$i" -lt 45 ]; do
    public_url=$(read_tunnel_url)
    [ -n "$public_url" ] && break
    pid_alive "$TUNNEL_PID_FILE" || break
    i=$((i + 1))
    sleep 1
  done

  if [ -z "$public_url" ]; then
    dump_tunnel_logs
    fail "the tunnel agent did not report a public URL; see $TUNNEL_LOG"
  fi

  # cloudflared registers a connector after printing the hostname; ngrok's
  # output already means the tunnel is up, so this only applies to quick.
  if [ "$TUNNEL_PROVIDER" = "quick" ]; then
    i=0
    while [ "$i" -lt 45 ]; do
      grep -q 'Registered tunnel connection' "$TUNNEL_LOG" 2>/dev/null && break
      pid_alive "$TUNNEL_PID_FILE" || break
      i=$((i + 1))
      sleep 1
    done
  fi

  # A tunnel can report a URL and die a second later (missing authtoken, rate
  # limiting). Without this settle check a dead URL gets recorded as healthy.
  sleep 2
  if ! pid_alive "$TUNNEL_PID_FILE"; then
    dump_tunnel_logs
    fail "the tunnel agent exited right after reporting a URL (an ngrok authtoken problem or quick-tunnel rate limiting: fix that, wait a minute, then run start.sh once)"
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
    dump_tunnel_logs
    fail "the tunnel did not serve this server; not recording $public_url as usable"
  fi

  printf '%s\n' "$public_url" >"$TUNNEL_URL_FILE"
  ok "public tunnel: $public_url (verified, provider: $TUNNEL_PROVIDER)"
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
  printf '  tunnel provider     : %s\n' "$TUNNEL_PROVIDER"
fi
printf '  bearer token        : %s\n' "$(print_token)"
printf '\n'
printf 'Add the endpoint and the token in FreeMilk: Settings > Integrations >\n'
printf 'Add MCP server (Streamable HTTP transport).\n'
printf '\n'
printf 'Full paste-able report: sh %s/report.sh\n' "$REPO_DIR"
printf '\n'
if [ "$TUNNEL_PROVIDER" = "quick" ] && [ -n "$public_url" ]; then
  warn "Quick Tunnel hostnames change on every restart. Set PHONE_MCP_TUNNEL_PROVIDER=ngrok in $CONFIG_FILE for a hostname that stays the same."
fi
