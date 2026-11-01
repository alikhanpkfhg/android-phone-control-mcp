#!/usr/bin/env sh
#
# One command: start the MCP server, get a *verified* public URL, and print a
# block you can paste.
#
#   sh connect.sh          use the provider in config.env, fall back to quick
#   sh connect.sh ngrok    try ngrok only
#   sh connect.sh quick    try the Cloudflare Quick Tunnel only
#
# If the configured provider cannot establish a tunnel (an ngrok session that
# will not authenticate, or a Quick Tunnel that is being rate limited), the
# default mode retries once with the other provider so you still get a working
# endpoint instead of a dead end.
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
failed_provider=""

if [ -n "$REQUESTED" ]; then
  case "$REQUESTED" in
    quick | ngrok) ;;
    *) fail "unknown provider \"$REQUESTED\" (use quick or ngrok)" ;;
  esac
  say "Starting with the $REQUESTED provider only"
  if try_with_provider "$REQUESTED"; then
    started=1
  fi
  if [ "$started" -ne 1 ]; then
    fail "the $REQUESTED provider did not come up, and only it was tried because it was asked for explicitly"
  fi
else
  if sh "$SELF_DIR/start.sh"; then
    started=1
  else
    failed_provider="$TUNNEL_PROVIDER"
  fi

  if [ "$started" -ne 1 ]; then
    warn "the $failed_provider provider did not come up; see the log lines above"

    # Try the other provider, in either direction: a Quick Tunnel that is being
    # rate limited should fall through to ngrok, and a broken ngrok session
    # should fall through to a Quick Tunnel.
    other=""
    case "$failed_provider" in
      ngrok) other="quick" ;;
      *)
        if ngrok_bin >/dev/null 2>&1; then
          other="ngrok"
        fi
        ;;
    esac

    if [ -z "$other" ]; then
      fail "no other provider is available. Install ngrok (pkg install -y ngrok) and run: ngrok config add-authtoken <your-authtoken>"
    fi

    warn "retrying once with the $other provider"
    if try_with_provider "$other"; then
      started=1
      warn "connected over $other instead. Set PHONE_MCP_TUNNEL_PROVIDER=$other in $CONFIG_FILE to make that permanent."
    fi
  fi
fi

if [ "$started" -ne 1 ]; then
  fail "neither provider produced a working tunnel"
fi

printf '\n'
say "Connected. The block below is safe to paste (it contains no token)."
printf '\n'
sh "$SELF_DIR/report.sh"
printf '\n'
printf 'The bearer token for the client is in %s\n' "$TOKEN_FILE"
printf 'Copy it into the MCP server settings when it asks for the API key.\n'
