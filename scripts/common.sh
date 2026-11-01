#!/bin/sh
#
# Shared helpers for the android-phone-control-mcp shell scripts.
# Sourced by install.sh, start.sh, stop.sh, status.sh and scripts/selftest.sh.
# It only defines variables and functions: sourcing it must have no side effects.

say() { printf '==> %s\n' "$*"; }
ok() { printf '[ok] %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }
fail() {
  printf '[x] %s\n' "$*" >&2
  exit 1
}

is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] && return 0
  case "${PREFIX:-}" in
    *com.termux*) return 0 ;;
  esac
  return 1
}

resolve_home() {
  printf '%s' "${PHONE_MCP_HOME:-$HOME/.android-phone-control-mcp}"
}

# Load ~/.android-phone-control-mcp/config.env (KEY=VALUE, shell syntax) and
# export the settings the server and the tunnel need.
load_config() {
  PHONE_MCP_HOME=$(resolve_home)
  CONFIG_FILE="${PHONE_MCP_CONFIG:-$PHONE_MCP_HOME/config.env}"

  if [ -f "$CONFIG_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
    set +a
  fi

  MCP_HOST="${MCP_HOST:-127.0.0.1}"
  MCP_PORT="${MCP_PORT:-8787}"
  BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:8766}"
  PHONE_MCP_CONFIRM="${PHONE_MCP_CONFIRM:-auto}"
  CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
  # quick = Cloudflare Quick Tunnel: no account, new hostname on every restart
  # ngrok = ngrok free plan: one dev domain per account that survives restarts
  TUNNEL_PROVIDER="${PHONE_MCP_TUNNEL_PROVIDER:-quick}"

  LOG_DIR="$PHONE_MCP_HOME/logs"
  RUN_DIR="$PHONE_MCP_HOME/run"
  TOKEN_FILE="$PHONE_MCP_HOME/token"
  MCP_PID_FILE="$RUN_DIR/mcp.pid"
  TUNNEL_PID_FILE="$RUN_DIR/cloudflared.pid"
  TUNNEL_URL_FILE="$PHONE_MCP_HOME/tunnel-url.txt"
  TUNNEL_LOG="$LOG_DIR/cloudflared.log"
  TUNNEL_CONSOLE_LOG="$LOG_DIR/cloudflared-console.log"
  MCP_LOG="$LOG_DIR/mcp.log"

  export PHONE_MCP_HOME MCP_HOST MCP_PORT BRIDGE_URL PHONE_MCP_CONFIRM CLOUDFLARED_PROTOCOL TUNNEL_PROVIDER
}

ensure_dirs() {
  mkdir -p "$PHONE_MCP_HOME" "$LOG_DIR" "$RUN_DIR"
  chmod 700 "$PHONE_MCP_HOME" 2>/dev/null || true
}

node_bin() { command -v node 2>/dev/null || true; }

require_node() {
  NODE_BIN=$(node_bin)
  [ -n "$NODE_BIN" ] || fail "Node.js is not installed. Run: pkg install -y nodejs-lts (or re-run install.sh)"
  export NODE_BIN
}

# Poll an HTTP endpoint with node's fetch, so curl/wget are not required.
# usage: health_ok http://127.0.0.1:8787/health
health_ok() {
  "${NODE_BIN:-node}" -e '
    const url = process.argv[1];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    fetch(url, { signal: controller.signal })
      .then((response) => { clearTimeout(timer); process.exit(response.ok ? 0 : 1); })
      .catch(() => { clearTimeout(timer); process.exit(1); });
  ' "$1" >/dev/null 2>&1
}

pid_alive() {
  [ -f "$1" ] || return 1
  pid=$(cat "$1" 2>/dev/null || true)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

cloudflared_bin() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi
  for candidate in \
    "$(resolve_home)/bin/cloudflared" \
    "$HOME/bin/cloudflared" \
    "${PREFIX:-/usr}/bin/cloudflared"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

ngrok_bin() {
  if command -v ngrok >/dev/null 2>&1; then
    command -v ngrok
    return 0
  fi
  for candidate in \
    "$(resolve_home)/bin/ngrok" \
    "$HOME/bin/ngrok" \
    "${PREFIX:-/usr}/bin/ngrok"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

pkg_install() {
  command -v pkg >/dev/null 2>&1 || return 1
  if command -v yes >/dev/null 2>&1; then
    yes 2>/dev/null | pkg install -y "$@" >/dev/null 2>&1 && return 0
  fi
  pkg install -y "$@" >/dev/null 2>&1
}

print_token() {
  if [ -f "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
  else
    printf '(missing - run install.sh)'
  fi
}
