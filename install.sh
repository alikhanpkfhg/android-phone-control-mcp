#!/usr/bin/env sh
#
# One-command installer for android-phone-control-mcp (Android + Termux).
#
#   curl -fsSL https://raw.githubusercontent.com/alikhanpkfhg/android-phone-control-mcp/main/install.sh | sh
#
# It can also be run from a clone:  sh install.sh
#
# What it does:
#   * fetches the repository next to $HOME when run through a pipe
#   * installs nodejs / git / android-tools / cloudflared when needed
#   * generates a random bearer token in ~/.android-phone-control-mcp/token (0600)
#   * writes ~/.android-phone-control-mcp/config.env (never the token)
#   * checks the existing phone bridge on 127.0.0.1:8766 and adb
set -eu

REPO_URL="${PHONE_MCP_REPO_URL:-https://github.com/alikhanpkfhg/android-phone-control-mcp.git}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')
REPO_DIR="${PHONE_MCP_REPO_DIR:-$HOME/android-phone-control-mcp}"

die() {
  printf '[x] %s\n' "$*" >&2
  exit 1
}
note() { printf '==> %s\n' "$*"; }

if [ ! -f "$SELF_DIR/src/main.js" ] || [ ! -f "$SELF_DIR/package.json" ]; then
  note "Fetching android-phone-control-mcp into $REPO_DIR"
  command -v git >/dev/null 2>&1 || die "git is required to download the project. Run: pkg install -y git"
  if [ -d "$REPO_DIR/.git" ]; then
    (cd "$REPO_DIR" && git pull --ff-only) ||
      printf '[!] could not update %s, continuing with the existing copy\n' "$REPO_DIR" >&2
  else
    git clone --depth 1 "$REPO_URL" "$REPO_DIR" ||
      die "git clone failed. Check the network, then run: git clone $REPO_URL $REPO_DIR"
  fi
else
  REPO_DIR="$SELF_DIR"
fi

[ -f "$REPO_DIR/src/main.js" ] || die "the project files are missing in $REPO_DIR"

# shellcheck source=scripts/common.sh
. "$REPO_DIR/scripts/common.sh"

install_packages() {
  if ! is_termux; then
    warn "this does not look like Termux; skipping pkg install."
    warn "make sure Node.js 18+, git, adb and cloudflared are installed."
    return 0
  fi
  note "Installing Termux packages (nodejs, git, android-tools, curl)"
  if command -v yes >/dev/null 2>&1; then
    yes 2>/dev/null | pkg update -y >/dev/null 2>&1 || warn "pkg update failed; continuing with the current package lists"
  else
    pkg update -y >/dev/null 2>&1 || warn "pkg update failed; continuing with the current package lists"
  fi
  pkg_install nodejs-lts || pkg_install nodejs || warn "could not install nodejs automatically"
  pkg_install git || warn "could not install git automatically"
  pkg_install android-tools || warn "could not install android-tools automatically (fine if adb already works)"
  pkg_install curl || true
  command -v node >/dev/null 2>&1 || die "Node.js is still missing. Run: pkg install -y nodejs-lts"
}

install_cloudflared() {
  if bin=$(cloudflared_bin); then
    ok "cloudflared already available: $bin"
    return 0
  fi

  if is_termux && pkg_install cloudflared && bin=$(cloudflared_bin); then
    ok "cloudflared installed from the Termux repository: $bin"
    return 0
  fi

  note "Downloading the official cloudflared static binary"
  case "$(uname -m)" in
    aarch64 | arm64) cf_arch=arm64 ;;
    armv7l | armv8l | arm) cf_arch=arm ;;
    x86_64 | amd64) cf_arch=amd64 ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac

  dest="$(resolve_home)/bin"
  mkdir -p "$dest"
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch"

  command -v curl >/dev/null 2>&1 || pkg_install curl || true
  command -v curl >/dev/null 2>&1 || die "curl is required to download cloudflared. Run: pkg install -y curl"
  curl -fL --retry 3 --connect-timeout 20 -o "$dest/cloudflared" "$url" ||
    die "could not download cloudflared from $url"
  chmod +x "$dest/cloudflared"
  ok "cloudflared installed at $dest/cloudflared"
}

install_ngrok() {
  if bin=$(ngrok_bin); then
    ok "ngrok already available: $bin"
  elif is_termux && pkg_install ngrok && bin=$(ngrok_bin); then
    ok "ngrok installed from the Termux repository: $bin"
  else
    warn "ngrok is not installed."
    warn "Download it with the command shown at https://dashboard.ngrok.com/get-started/setup"
    warn "then run:  ngrok config add-authtoken <your-authtoken>"
  fi
}

check_node() {
  require_node
  version=$("$NODE_BIN" -p 'process.versions.node')
  major=${version%%.*}
  [ "$major" -ge 18 ] || fail "Node.js $version is too old; install Node 18+ with: pkg install -y nodejs-lts"
  ok "node $version"
}

generate_token() {
  ensure_dirs
  if [ -s "$TOKEN_FILE" ]; then
    ok "re-using the existing bearer token at $TOKEN_FILE"
    return 0
  fi
  require_node
  umask 077
  "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")' >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  ok "generated a new bearer token at $TOKEN_FILE (mode 600)"
}

write_config() {
  ensure_dirs
  if [ -f "$CONFIG_FILE" ]; then
    ok "keeping the existing config at $CONFIG_FILE"
    return 0
  fi
  cat >"$CONFIG_FILE" <<'EOF'
# android-phone-control-mcp configuration (read by install/start/stop/status).
# The bearer token is NOT stored here: it lives in ./token with mode 600.

# The MCP server always binds loopback; only this port is ever tunneled.
MCP_HOST=127.0.0.1
MCP_PORT=8787

# The existing Termux phone bridge. It stays on localhost and is never published.
BRIDGE_URL=http://127.0.0.1:8766

# auto   = phone_type_text and ENTER must be confirmed (recommended)
# strict = every input tool must be confirmed
# none   = no server side confirmation gate
PHONE_MCP_CONFIRM=auto

# http2 is far more reliable than QUIC on mobile networks.
CLOUDFLARED_PROTOCOL=http2

# Which tunnel to run:
#   quick = Cloudflare Quick Tunnel, no account, new hostname on every restart
#   ngrok = ngrok free plan, one dev domain that survives restarts
PHONE_MCP_TUNNEL_PROVIDER=quick
EOF
  chmod 600 "$CONFIG_FILE"
  ok "wrote $CONFIG_FILE"
}

check_bridge() {
  note "Checking the phone bridge at $BRIDGE_URL"
  if health_ok "$BRIDGE_URL/health"; then
    ok "bridge is reachable; screenshots will use it"
  else
    warn "the bridge at $BRIDGE_URL/health does not answer right now."
    warn "phone_screenshot still works through adb, but start your bridge before using it."
  fi
}

check_adb() {
  if command -v adb >/dev/null 2>&1; then
    ok "adb found: $(command -v adb)"
    if adb devices 2>/dev/null | grep -q "device$"; then
      ok "a device is connected to adb"
    else
      warn "no adb device is currently listed as 'device'; check wireless debugging"
    fi
  else
    warn "adb not found; the input tools need it: pkg install -y android-tools"
  fi
}

print_summary() {
  token=$(print_token)
  printf '\n'
  say "android-phone-control-mcp is installed."
  printf '\n'
  printf '  project       : %s\n' "$REPO_DIR"
  printf '  config        : %s\n' "$CONFIG_FILE"
  printf '  bearer token  : %s\n' "$token"
  printf '  local MCP     : http://127.0.0.1:%s/mcp\n' "$MCP_PORT"
  printf '  phone bridge  : %s (localhost only, never tunneled)\n' "$BRIDGE_URL"
  printf '\n'
  printf '  Start it : sh %s/start.sh\n' "$REPO_DIR"
  printf '  Status   : sh %s/status.sh\n' "$REPO_DIR"
  printf '  Stop     : sh %s/stop.sh\n' "$REPO_DIR"
  printf '  Self test: node %s/scripts/selftest.js\n' "$REPO_DIR"
  printf '\n'
  printf '  Keep the bearer token secret: anyone holding it can control this\n'
  printf '  phone through the tunnel. Skip the tunnel with PHONE_MCP_TUNNEL=0.\n'
  printf '\n'
}

load_config
ensure_dirs
install_packages
check_node
if [ "${PHONE_MCP_TUNNEL_PROVIDER:-quick}" = "ngrok" ]; then
  install_ngrok
else
  install_cloudflared
fi
generate_token
write_config
check_bridge
check_adb
print_summary
