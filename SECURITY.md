# Security

This project turns a phone into a remote-controllable device for an AI assistant. Treat the bearer token like a password.

## Secrets

* The bearer token is generated locally on first install (`install.sh`) with `crypto.randomBytes(32)`, stored at `~/.android-phone-control-mcp/token`, mode `600`, and reused on every restart.
* `token`, `tunnel-url.txt`, `.env`, logs and pid files are in `.gitignore` and CI fails if any of them is tracked.
* No token, password, key or account identifier is committed to this repository.

## Network exposure

| Port | Where | Exposed? |
| --- | --- | --- |
| `8787` | MCP server | Only through the Cloudflare Quick Tunnel |
| `8766` | existing phone bridge | **Never** — localhost only |

`src/config.js` refuses to start when `MCP_PORT` equals the bridge port, and `src/tunnel.js` refuses to build a tunnel for anything other than the MCP port. CI asserts that `8766` never appears in the cloudflared arguments.

## Authentication

Every `POST /mcp` requires `Authorization: Bearer <token>`; the comparison hashes both sides and uses `crypto.timingSafeEqual`. Missing or wrong credentials get `401` with a `WWW-Authenticate` header. Query strings and cookies are ignored. `/health` is unauthenticated on purpose and returns only service name, version and uptime.

## Command execution

There is no shell tool. Each tool builds one fixed `adb` invocation from validated arguments:

* coordinates must be whole numbers within `0..20000` and inside the reported screen size
* keys come from a whitelist of aliases or an explicit `KEYCODE_*` name
* text must be printable ASCII without line breaks and is shell-escaped before being passed to `adb shell input text`
* package names must match an Android application id pattern
* unknown argument keys are rejected

## Irreversible actions

`PHONE_MCP_CONFIRM=auto` (default) refuses `phone_type_text` and `phone_press_key(ENTER)` unless the call carries `"confirm": true`. `strict` extends that to every input tool. The MCP `instructions` additionally require the assistant to ask the user before payments, purchases, account deletion, sending messages or granting permissions.

## Reporting

Open an issue without including tokens, tunnel hostnames or screenshots that contain personal data.
