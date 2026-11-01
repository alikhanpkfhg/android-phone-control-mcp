# android-phone-control-mcp

An MCP (Model Context Protocol) server that lets an AI assistant drive **a real Android phone** — yours — from [FreeMilk](https://github.com/) or any other MCP client, using nothing but Termux on the phone itself. No laptop, no VPS, no paid sandbox, no paid hosting.

It speaks **MCP Streamable HTTP** on `127.0.0.1:8787`, requires a **locally generated bearer token** on every request, reuses the phone bridge that is already running on `127.0.0.1:8766`, and publishes only port `8787` through a **Cloudflare Quick Tunnel**.

```
┌─────────────┐   HTTPS + Bearer token   ┌──────────────────────────┐
│  FreeMilk   │  ──────────────────────> | cloudflared quick tunnel  |
│  (MCP       │                          +------------+-------------+
│   client)   │                                       | http://127.0.0.1:8787
└─────────────┘                                       v
                                        +-----------------------------+
                                        |  MCP server (Node.js)       |
                                        |  Streamable HTTP, token auth|
                                        +------+---------------+------+
                                               |               |
                            http://127.0.0.1:8766          adb shell
                                               v               v
                                        +-----------------------------+
                                        |   YOUR ANDROID PHONE        |
                                        +-----------------------------+
```

The bridge on port **8766** is used from localhost only and is **never** part of the tunnel. Only the MCP port (8787) is published.

## Tools

| Tool | What it does |
| --- | --- |
| `phone_status` | Bridge/adb reachability, attached device, screen size. Read-only. |
| `phone_screenshot` | Current screen as real MCP **image content** (PNG). Bridge first, `adb exec-out screencap -p` as fallback. Read-only. |
| `phone_tap` | Tap a pixel coordinate. |
| `phone_swipe` | Swipe between two coordinates with a duration. |
| `phone_press_key` | HOME, BACK, APP_SWITCH, ENTER, TAB, DEL, DPAD_*, VOLUME_*, POWER, WAKEUP, or an explicit `KEYCODE_*`. |
| `phone_launch_app` | Bring an installed app to the foreground by package name. |
| `phone_type_text` | Type printable ASCII into the focused field. |

There is **no shell tool**. Nothing in this server can run arbitrary commands; every tool maps to one fixed `adb shell input …` (or `monkey` / `am start`) invocation built from validated arguments.

## Requirements

* Android phone (developed against a **TECNO SPARK 20, Android 13**).
* **Termux** from F-Droid.
* `python`, `git`, `android-tools` (adb) — the installer adds what is missing.
* **Wireless debugging** already paired (`adb devices` shows the phone as `device`).
* Your existing phone bridge answering on `http://127.0.0.1:8766/health` and `/screenshot` (optional: without it, screenshots fall back to adb).
* Node.js 18+ (`pkg install -y nodejs-lts`) — the installer does this for you.

## One-command install

Paste this single line into Termux:

```sh
pkg install -y curl git nodejs-lts && curl -fsSL https://raw.githubusercontent.com/alikhanpkfhg/android-phone-control-mcp/main/install.sh | sh
```

The installer:

* clones the repository to `~/android-phone-control-mcp` (or updates an existing clone)
* installs `nodejs`, `git`, `android-tools`, `curl` and `cloudflared` (Termux repo, or the official static binary if the package is missing)
* generates a **random 32-byte bearer token** in `~/.android-phone-control-mcp/token` (mode `600`) and **keeps it across restarts**
* writes `~/.android-phone-control-mcp/config.env` (never contains the token)
* checks the existing bridge on **8766** and `adb devices`
* prints the token and the next commands

It has no npm dependencies, so there is nothing to `npm install`.

## Start it

```sh
sh ~/android-phone-control-mcp/start.sh
```

It starts the MCP server on `127.0.0.1:8787`, starts a Cloudflare Quick Tunnel, waits for a **registered** connector, then **verifies the public URL really reaches this server** before recording it, and prints:

```
  local MCP endpoint  : http://127.0.0.1:8787/mcp
  public MCP endpoint : https://random-words.trycloudflare.com/mcp
  bearer token        : <your token>
```

Other commands:

```sh
sh ~/android-phone-control-mcp/connect.sh     # start everything, print a block to paste
sh ~/android-phone-control-mcp/status.sh     # state, URLs, token, logs
sh ~/android-phone-control-mcp/stop.sh       # stop server + tunnel
sh ~/android-phone-control-mcp/report.sh     # paste-able report, no token in it
node ~/android-phone-control-mcp/scripts/selftest.js   # live smoke test
PHONE_MCP_TUNNEL=0 sh ~/android-phone-control-mcp/start.sh   # local only
```

`connect.sh` is the one to use when you just want it working: it starts the server and the tunnel, verifies the public URL, and then prints the report. If the configured provider cannot establish a tunnel at all, it retries once with the **other** provider, so a Quick Tunnel that is being rate limited falls through to ngrok and a broken ngrok session falls through to a Quick Tunnel. `sh connect.sh quick` and `sh connect.sh ngrok` force one provider, with no fallback, for a single run.

`report.sh` prints the version, both endpoints, a live check of the public tunnel, every local protocol check and the phone's real state. It never prints the bearer token, so its output is safe to paste into a chat or an issue.

Logs: `~/.android-phone-control-mcp/logs/mcp.log` and `logs/cloudflared.log`.

> Cloudflare Quick Tunnel hostnames are **not stable**: every restart gets a new `https://*.trycloudflare.com` name, so the endpoint has to be re-added each time. For a hostname that survives restarts, use the ngrok provider below.

## A tunnel that stays the same (ngrok, free)

The Quick Tunnel is fine for a first test but it is the wrong tool for daily use: the hostname changes on every restart, and Cloudflare's own log says these account-less tunnels carry no uptime guarantee.

ngrok's free plan gives you **one dev domain per account** (something like `your-name.ngrok-free.app`) that **does not change when the agent restarts**, and free endpoints have **no timeout** — they stay online as long as the agent runs. Limits that matter here: 1 GB out and 20,000 HTTP requests per month, 3 online endpoints. The interstitial page ngrok shows on the free tier only affects HTML browser traffic and does not apply to API clients.

One-time setup:

```sh
# 1. create a free account at https://dashboard.ngrok.com/signup
# 2. install the agent (Termux package, or the download command shown at
#    https://dashboard.ngrok.com/get-started/setup)
pkg install -y ngrok

# 3. give the agent YOUR ngrok authtoken (from the dashboard)
ngrok config add-authtoken <your-authtoken>

# 4. switch the provider
echo 'PHONE_MCP_TUNNEL_PROVIDER=ngrok' >> ~/.android-phone-control-mcp/config.env

# 5. start again
sh ~/android-phone-control-mcp/start.sh
```

There are now **two different secrets**, and they are not interchangeable:

* the **ngrok authtoken** proves your agent belongs to your ngrok account. It goes into `ngrok config`, never into an MCP client.
* the **MCP bearer token** at `~/.android-phone-control-mcp/token` is what the client sends on every request. Start it with the `PHONE_MCP_TUNNEL_PROVIDER=ngrok` line above and `start.sh` prints it.

Keeping the agent alive is the other half of staying reachable: hold `termux-wake-lock`, disable battery optimisation for Termux, and run it inside `tmux` so closing the session does not kill it.

### Why not Tailscale Funnel

It is a reasonable option — stable `*.ts.net` hostnames and no domain to buy — but it is still in beta, needs the Tailscale CLI on the device and HTTPS certificates plus a policy attribute in the tailnet, and it can only listen on ports 443, 8443 and 10000, so the MCP port would have to move. ngrok is a single binary and one config line.

## Add it to FreeMilk

1. Run `connect.sh` (or `start.sh`) and copy the endpoint it prints.
2. In FreeMilk open **Settings → Integrations → Add MCP server**.
3. Transport: **Streamable HTTP**.
4. URL: `https://<the-printed-host>.trycloudflare.com/mcp` (or `http://127.0.0.1:8787/mcp` if you are on the same phone).
5. Authentication: **Bearer token** with the printed token.
6. Save, then ask the assistant to call `phone_status` and `phone_screenshot`.

## Security model

* **Token**: 32 random bytes (base64url) generated on first install, stored at `~/.android-phone-control-mcp/token` with mode `600`, never committed, never printed in full by the logs (only `abcd...mnop`). Every `/mcp` request is checked with a constant-time comparison; missing or wrong tokens get `401`.
* **Loopback only**: the MCP server binds `127.0.0.1` by default and refuses a non-loopback `MCP_HOST` unless `PHONE_MCP_ALLOW_REMOTE_BIND=1` is set explicitly.
* **One published port**: the tunnel targets `http://127.0.0.1:8787` and nothing else. The code refuses to build a tunnel for the bridge port, and the config refuses to let the MCP port equal the bridge port.
* **The bridge stays private**: `http://127.0.0.1:8766` is only ever contacted from localhost by the MCP server.
* **No shell**: no tool accepts a command, a path or a URL. Arguments are validated against fixed schemas; unknown keys, out-of-range coordinates, non-ASCII text and strange package names are rejected before anything reaches adb.
* **Body limits**: request bodies are capped (2 MB) and JSON parse errors return `-32700`.

### Confirmation of irreversible actions

`PHONE_MCP_CONFIRM` controls the server side gate:

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | `phone_type_text` and `phone_press_key` with `ENTER` are refused unless the call carries `"confirm": true`. |
| `strict` | Every input tool (`tap`, `swipe`, `press_key`, `launch_app`, `type_text`) requires `"confirm": true`. |
| `none` | No server side gate (not recommended). |

Read-only tools (`phone_status`, `phone_screenshot`) never require confirmation.

On top of the gate, the server's MCP `instructions` tell the assistant to ask the user before payments, purchases, account deletion, sending messages, granting permissions, accepting terms, or any other irreversible action. Typing and pressing ENTER are the exact primitives those flows are built from, which is why they are gated by default.

**This is a remote control for your own phone.** Keep the token secret, keep the tunnel short-lived, and stop the tunnel (`stop.sh`) when you are not using it.

## Configuration

`~/.android-phone-control-mcp/config.env` (created by the installer):

```sh
MCP_HOST=127.0.0.1
MCP_PORT=8787
BRIDGE_URL=http://127.0.0.1:8766
PHONE_MCP_CONFIRM=auto
CLOUDFLARED_PROTOCOL=http2
```

Any of the server's environment variables can also be exported before `start.sh`: `MCP_HOST`, `MCP_PORT`, `BRIDGE_URL`, `BRIDGE_INPUT` (`auto`/`adb`/`bridge`), `ADB_BIN`, `ADB_TIMEOUT_MS`, `BRIDGE_TIMEOUT_MS`, `MAX_TEXT_LENGTH`, `PHONE_MCP_CONFIRM`, `PHONE_MCP_HOME`, `TOKEN_FILE`, `LOG_FILE`, `MCP_MAX_BODY_BYTES`, `CLOUDFLARED_PROTOCOL`.

## How the phone is driven

* **Screenshots** — `GET http://127.0.0.1:8766/screenshot` (raw image or JSON with base64), then `adb exec-out screencap -p`.
* **Input** — the server first tries the bridge (`POST /tap`, `/swipe`, `/key`, `/text`, `/launch`). If the bridge does not implement those routes (the stock bridge only serves `/health` and `/screenshot`), it falls back to adb automatically: `input tap`, `input swipe`, `input keyevent`, `input text`, `monkey -p <pkg>` with `am start` fallback. Force either path with `BRIDGE_INPUT=adb` or `BRIDGE_INPUT=bridge`.
* **Screen size** — `adb shell wm size`, cached for 60 s and used to reject coordinates outside the display.

### Known limitation

`adb shell input text` can only type **printable ASCII**. Emoji, accents, CJK and other characters cannot be injected that way. For those, tap the on-screen keyboard keys with `phone_tap` (or use a helper IME). The tool says so instead of silently failing.

## Testing

Automated checks run in GitHub Actions (`.github/workflows/ci.yml`, Node 20 and 22):

* `sh -n` syntax check of every shell script
* a "no secret files tracked" check (`token`, `.env`, private keys, `tunnel-url.txt`) and a scan for credential-looking strings
* `node --test test/*.test.js`:
  * unit tests for config, tunnel-target safety, token generation/permissions/reuse, constant-time comparison, bearer parsing, coordinate/key/text/package validation, screen bounds, adb device parsing, input text escaping
  * integration tests that boot the real HTTP server against a **fake bridge** and a **fake `adb`** and exercise: `/health` without a token, `401` for missing/wrong/Basic auth, `initialize` (current and older protocol versions), `tools/list` (all seven tools with schemas), `phone_status`, `phone_screenshot` (bridge image, bridge base64 JSON, adb fallback with the bridge down), coordinate validation, `confirm` gating in `auto`/`strict`/`none` modes, unknown tools/methods, malformed JSON, batch requests, notifications (`202`), and clients that only accept `text/event-stream`
  * a test asserting the tunnel target is `127.0.0.1:8787` and that `8766` never appears in the cloudflared arguments
* `scripts/selftest.js` repeats the important checks against a running installation, including that the public tunnel refuses anonymous requests

### What has been verified here, and what has not

Verified in CI (no phone involved): protocol handling, authentication, argument validation, confirmation gating, image content shape, adb/bridge fallback logic, tunnel target safety, tunnel liveness verification, and shell script syntax.

**Not verified from here:** the behaviour of the real TECNO SPARK 20 through the real bridge and real adb. This repository was written without a device attached. Run `node ~/android-phone-control-mcp/scripts/selftest.js` on the phone after `start.sh`; it exercises `phone_status` and `phone_screenshot` against the real device and reports PASS/FAIL per check. Only claim the phone works after that output shows `phone_screenshot` returning a real screen image.

## Troubleshooting

**`the MCP server did not become healthy`** — read `~/.android-phone-control-mcp/logs/mcp.log`. A port clash shows as `EADDRINUSE`; something else is already using 8787.

**`phone_screenshot` fails** — check `adb devices` shows your phone as `device`, then check `curl http://127.0.0.1:8766/health`. Either path alone is enough.

**`adb command failed: ... unauthorized`** — re-accept the wireless debugging prompt on the phone.

**Tunnel URL 530 / 502 / 1033** — the Cloudflare edge has no live connector for that hostname. A trycloudflare hostname outlives the cloudflared process that created it, so a URL read from the log (or from `tunnel-url.txt`) can look perfectly valid while being completely dead. Run `sh start.sh`: it notices the recorded tunnel does not answer and replaces it. Never reuse a hostname from an old run.

**FreeMilk cannot connect** — make sure the URL ends in `/mcp`, the transport is Streamable HTTP, and the token was pasted without a trailing space.

**Cloudflared will not start in Termux** — `CLOUDFLARED_PROTOCOL=http2` (the default) avoids the QUIC problems common on mobile networks. If the downloaded static binary refuses to run on your Android version, install the Termux package instead (`pkg install -y cloudflared`) and re-run `start.sh`; the script picks up whichever binary it finds.

## Uninstall

```sh
sh ~/android-phone-control-mcp/stop.sh
rm -rf ~/android-phone-control-mcp ~/.android-phone-control-mcp
```

## License

MIT. You are responsible for what you do with it: use it on devices you own.
