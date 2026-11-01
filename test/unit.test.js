import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";
import { isAuthorized, parseBearer } from "../src/auth.js";
import { escapeInputText, parseAdbDevices } from "../src/phone.js";
import { ensureTokenFile, maskToken, readToken, safeEqual } from "../src/token.js";
import { buildTunnelArgs, extractTunnelUrl, publicMcpUrl, tunnelTarget } from "../src/tunnel.js";
import {
  ValidationError,
  assertKnownKeys,
  assertWithinScreen,
  booleanArg,
  coordinateArg,
  integerArg,
  normalizeKey,
  stringArg,
  validatePackageName,
  validateText,
} from "../src/validate.js";

test("config defaults keep everything on loopback", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.bridgeUrl, "http://127.0.0.1:8766");
  assert.equal(cfg.bridgePort, 8766);
  assert.equal(cfg.bridgeLoopback, true);
  assert.equal(cfg.confirmMode, "auto");
  assert.equal(cfg.bridgeInput, "auto");
  assert.equal(cfg.tunnel.port, 8787);
});

test("config refuses to reuse the bridge port for the MCP server", () => {
  assert.throws(
    () => loadConfig({ MCP_PORT: "8766", BRIDGE_URL: "http://127.0.0.1:8766" }),
    (error) => error instanceof ConfigError && /must differ/.test(error.message),
  );
});

test("config refuses a non-loopback bind unless explicitly allowed", () => {
  assert.throws(
    () => loadConfig({ MCP_HOST: "0.0.0.0" }),
    (error) => error instanceof ConfigError && /not a loopback address/.test(error.message),
  );
  const cfg = loadConfig({ MCP_HOST: "0.0.0.0", PHONE_MCP_ALLOW_REMOTE_BIND: "1" });
  assert.equal(cfg.host, "0.0.0.0");
});

test("config rejects invalid values with clear errors", () => {
  assert.throws(() => loadConfig({ MCP_PORT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ MCP_PORT: "70000" }), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_URL: "not-a-url" }), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_URL: "ftp://127.0.0.1:8766" }), ConfigError);
  assert.throws(() => loadConfig({ PHONE_MCP_CONFIRM: "sometimes" }), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_INPUT: "telepathy" }), ConfigError);
});

test("the tunnel only ever targets the MCP port", () => {
  const cfg = loadConfig({});
  assert.equal(tunnelTarget(cfg), "http://127.0.0.1:8787");

  const args = buildTunnelArgs(cfg);
  const joined = args.join(" ");
  assert.match(joined, /http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(joined, /8766/);
  assert.ok(args.includes("--no-autoupdate"));

  assert.throws(() => tunnelTarget({ port: 8787, bridgePort: 8787, tunnel: { port: 8787 } }), ConfigError);
});

test("public MCP URL is derived from the quick tunnel hostname", () => {
  const log =
    'INF |  https://random-words-here.trycloudflare.com  |\n';
  assert.equal(extractTunnelUrl(log), "https://random-words-here.trycloudflare.com");
  assert.equal(extractTunnelUrl("nothing here"), null);
  assert.equal(
    publicMcpUrl("https://random-words-here.trycloudflare.com"),
    "https://random-words-here.trycloudflare.com/mcp",
  );
});

test("token file is generated once, kept private and reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-mcp-token-"));
  const tokenFile = path.join(dir, "nested", "token");

  const first = ensureTokenFile(tokenFile);
  assert.equal(first.created, true);
  assert.ok(first.token.length >= 40);

  const second = ensureTokenFile(tokenFile);
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.equal(readToken(tokenFile), first.token);

  if (process.platform !== "win32") {
    const mode = fs.statSync(tokenFile).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  assert.equal(readToken(path.join(dir, "does-not-exist")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("token comparison is constant time and length safe", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcdef"), false);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual(undefined, "abc"), false);
  assert.equal(maskToken("abcdefghijklmnop"), "abcd...mnop");
  assert.equal(maskToken("short"), "***");
});

test("bearer parsing accepts only the Bearer scheme", () => {
  assert.equal(parseBearer("Bearer abc123"), "abc123");
  assert.equal(parseBearer("bearer   abc123  "), "abc123");
  assert.equal(parseBearer("Basic abc123"), null);
  assert.equal(parseBearer("Bearer"), null);
  assert.equal(parseBearer(undefined), null);

  const request = { headers: { authorization: "Bearer secret-token" } };
  assert.equal(isAuthorized(request, "secret-token"), true);
  assert.equal(isAuthorized(request, "other-token"), false);
  assert.equal(isAuthorized({ headers: {} }, "secret-token"), false);
  assert.equal(isAuthorized({ headers: { authorization: "Bearer " } }, "secret-token"), false);
});

test("coordinates are validated as whole pixels", () => {
  assert.equal(coordinateArg({ x: 10 }, "x"), 10);
  assert.equal(coordinateArg({ x: "10" }, "x"), 10);
  assert.throws(() => coordinateArg({ x: -1 }, "x"), ValidationError);
  assert.throws(() => coordinateArg({ x: 20001 }, "x"), ValidationError);
  assert.throws(() => coordinateArg({ x: 1.5 }, "x"), ValidationError);
  assert.throws(() => coordinateArg({}, "x"), ValidationError);
  assert.throws(() => coordinateArg({ x: "abc" }, "x"), ValidationError);
});

test("integer and string helpers report the offending field", () => {
  assert.equal(integerArg({ d: 300 }, "d", { min: 50, max: 5000, fallback: 100 }), 300);
  assert.equal(integerArg({}, "d", { fallback: 100 }), 100);
  assert.throws(() => integerArg({ d: 10 }, "d", { min: 50, max: 5000 }), ValidationError);
  assert.throws(() => integerArg({}, "d", { required: true }), ValidationError);

  assert.equal(stringArg({ key: " HOME " }, "key", { trim: true }), "HOME");
  assert.throws(() => stringArg({ key: 5 }, "key"), ValidationError);
  assert.throws(() => stringArg({ key: "x".repeat(50) }, "key", { maxLength: 10 }), ValidationError);
});

test("boolean helper accepts true/false and strings", () => {
  assert.equal(booleanArg({ confirm: true }, "confirm"), true);
  assert.equal(booleanArg({ confirm: "true" }, "confirm"), true);
  assert.equal(booleanArg({}, "confirm"), false);
  assert.throws(() => booleanArg({ confirm: "yes" }, "confirm"), ValidationError);
});

test("unknown arguments are rejected", () => {
  assert.doesNotThrow(() => assertKnownKeys({ x: 1 }, ["x", "y"]));
  assert.throws(() => assertKnownKeys({ x: 1, shell: "rm -rf /" }, ["x"]), ValidationError);
  assert.throws(() => assertKnownKeys(null, ["x"]), ValidationError);
});

test("key aliases and explicit keycodes are accepted, shell-ish input is not", () => {
  assert.deepEqual(normalizeKey("home"), { name: "HOME", argument: "KEYCODE_HOME" });
  assert.equal(normalizeKey("enter").argument, "KEYCODE_ENTER");
  assert.equal(normalizeKey("KEYCODE_HOME").argument, "KEYCODE_HOME");
  assert.equal(normalizeKey("KEYCODE_VOLUME_UP").argument, "KEYCODE_VOLUME_UP");
  assert.equal(normalizeKey("KEYCODE_4").name, "4");
  assert.throws(() => normalizeKey("rm -rf /"), ValidationError);
  assert.throws(() => normalizeKey(";reboot"), ValidationError);
  assert.throws(() => normalizeKey(""), ValidationError);
  assert.throws(() => normalizeKey(42), ValidationError);
});

test("typed text is printable ASCII without line breaks", () => {
  assert.equal(validateText("hello world"), "hello world");
  assert.throws(() => validateText(""), ValidationError);
  assert.throws(() => validateText("two\nlines"), ValidationError);
  assert.throws(() => validateText("tab\there"), ValidationError);
  assert.throws(() => validateText("emoji \u{1F600}"), ValidationError);
  assert.throws(() => validateText("caf\u00e9"), ValidationError);
  assert.throws(() => validateText("x".repeat(10), { maxLength: 5 }), ValidationError);
  assert.throws(() => validateText(undefined), ValidationError);
});

test("package names must look like android application ids", () => {
  assert.equal(validatePackageName("com.android.settings"), "com.android.settings");
  assert.equal(validatePackageName(" com.whatsapp "), "com.whatsapp");
  assert.throws(() => validatePackageName("settings"), ValidationError);
  assert.throws(() => validatePackageName("com.example; rm -rf /"), ValidationError);
  assert.throws(() => validatePackageName(undefined), ValidationError);
});

test("text is escaped for the device shell", () => {
  assert.equal(escapeInputText("hello world"), "hello%sworld");
  assert.equal(escapeInputText("a&b"), "a\\&b");
  assert.equal(escapeInputText("$HOME"), "\\$HOME");
  assert.equal(escapeInputText('say "hi"'), 'say%s\\"hi\\"');
});

test("screen bounds are enforced when the size is known", () => {
  assert.doesNotThrow(() => assertWithinScreen({ x: 719, y: 1611 }, { width: 720, height: 1612 }));
  assert.throws(
    () => assertWithinScreen({ x: 720, y: 10 }, { width: 720, height: 1612 }),
    ValidationError,
  );
  assert.doesNotThrow(() => assertWithinScreen({ x: 5000, y: 5000 }, null));
});

test("adb device output is parsed into devices", () => {
  const devices = parseAdbDevices(
    "List of devices attached\n10.0.0.2:5555\tdevice\nemulator-5554\toffline\n\n",
  );
  assert.equal(devices.length, 2);
  assert.equal(devices[0].serial, "10.0.0.2:5555");
  assert.equal(devices[0].state, "device");
  assert.equal(devices[1].state, "offline");
});
