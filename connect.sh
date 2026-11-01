#!/usr/bin/env sh
#
# One command: start the MCP server, get a *verified* public URL, and print a
# block you can paste.
#
#   sh connect.sh          use the provider in config.env, fall back to quick
#   sh connect.sh ngrok    try ngrok only
#   sh connect.sh quick    try the Cloudflare Quick Tunnel only
#
# If the configured provider cannot establish a tunnel (for example an ngrok
# session that will not authenticate), the default mode retries once with the
# Cloudflare Quick Tunnel so you still get a working endpoint instead of a dead
# end. The fallback hostname changes on every restart, so it is a stopgap, not
# the long-term answer.
set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')

# shellcheck source=scripts/common.sh
. "$SELF_DIR/scripts/common.sh"

load_config
ensure_dirs

REQUESTED="${1:-}"

# start.sh reads PHONE_MCP_CONFIG, so a temporary config with the provider
# appended is enough to force a provider for one run without editing the real
# config file (later lines win when the file is sourced).
try_with_provider() {
  provider="$1"
  tmp="$RUN_DIR/tmp-config.env"

  {
    if [ -f "$CONFIG_FILE" ]; then
      cat "$CONFIG_FILE"
    fi
    printf 'PHONE_MCP_TUNNEL_PROVIDER=%s\n' "$provider"
  } >"$tmp"

  PHONE_MCP_CONFIG="$tmp" sh "$SELF_DIR/start.sh"
  status=$?
  rm -f "$tmp"
  return "$status"
}

started=0

if [ -n "$REQUESTED" ]; then
  case "$REQUESTED" in
    quick | ngrok) ;;
    *) fail "unknown provider \"$REQUESTED\" (use quick or ngrok)" ;;
  esac
  say "Starting with the $REQUESTED provider"
  if try_with_provider "$REQUESTED"; then
    started=1
  fi
else
  if sh "$SELF_DIR/start.sh"; then
    started=1
  else
    warn "the $TUNNEL_PROVIDER tunnel did not come up; see the log lines above"
    if [ "$TUNNEL_PROVIDER" = "quick" ]; then
      fail "the Quick Tunnel failed too, so nothing was published"
    fi
    warn "retrying once with the Cloudflare Quick Tunnel"
    if try_with_provider quick; then
      started=1
      warn "connected over a Quick Tunnel: this hostname changes if the tunnel restarts"
    fi
  fi
fi

if [ "$started" -ne 1 ]; then
  fail "no working tunnel. Fix the provider and run this again."
fi

printf '\n'
say "Connected. The block below is safe to paste (it contains no token)."
printf '\n'
sh "$SELF_DIR/report.sh"
printf '\n'
printf 'The bearer token for the client is in %s\n' "$TOKEN_FILE"
printf 'Copy it into the MCP server settings when it asks for the API key.\n'
