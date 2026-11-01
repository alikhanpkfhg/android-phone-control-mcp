import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import { startServer } from "../../src/server.js";

/**
 * A 1x1 PNG. Only the signature matters: the server sniffs the content type of
 * what the bridge (or adb) returns.
 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

export const TEST_TOKEN = "test-token-0123456789abcdefghij";

/** Stand-in for the user's Termux bridge: /health and /screenshot only. */
export async function startFakeBridge(screenshotMode = "png") {
  const state = { screenshot: screenshotMode, requests: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    state.requests.push({ method: req.method, path: url.pathname });

    if (url.pathname === "/health") {
      const payload = JSON.stringify({ status: "ok", bridge: "fake" });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }

    if (url.pathname === "/screenshot") {
      if (state.screenshot === "fail") {
        const payload = JSON.stringify({ error: "boom" });
        res.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      if (state.screenshot === "json") {
        const payload = JSON.stringify({ base64: TINY_PNG_BASE64 });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      if (state.screenshot === "html") {
        const payload = "<html>nope</html>";
        res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      const png = Buffer.from(TINY_PNG_BASE64, "base64");
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      res.end(png);
      return;
    }

    // Input routes are deliberately unsupported, like the real bridge.
    const payload = JSON.stringify({ error: "not found" });
    res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A fake `adb` shell script: it records every call and answers the handful of
 * commands the phone driver runs.
 */
export function createFakeAdb(dir) {
  const logFile = path.join(dir, "adb.log");
  const pngFile = path.join(dir, "screen.png");
  const bin = path.join(dir, "fake-adb.sh");

  fs.writeFileSync(pngFile, Buffer.from(TINY_PNG_BASE64, "base64"));

  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${logFile}'`,
    'case "$*" in',
    `  *"exec-out screencap"*) cat '${pngFile}'; exit 0 ;;`,
    `  *"wm size"*) printf 'Physical size: 720x1612\\n'; exit 0 ;;`,
    `  *"version"*) printf 'Android Debug Bridge version 1.0.41\\n'; exit 0 ;;`,
    `  *"devices"*) printf 'List of devices attached\\nemulator-5554\\tdevice\\n\\n'; exit 0 ;;`,
    `  *"monkey"*) printf 'Events injected: 1\\n'; exit 0 ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n");

  fs.writeFileSync(bin, script, { mode: 0o755 });
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    /* ignore */
  }

  return {
    bin,
    logFile,
    pngFile,
    log() {
      try {
        return fs.readFileSync(logFile, "utf8");
      } catch {
        return "";
      }
    },
  };
}

/** A port nothing is listening on (used to simulate a dead bridge). */
export async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function startHarness({ bridgeUrl, bridgeOptions, token = TEST_TOKEN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-mcp-test-"));
  const bridge = await startFakeBridge(bridgeOptions);
  const adb = createFakeAdb(dir);

  const cfg = {
    ...loadConfig({
      PHONE_MCP_HOME: path.join(dir, "home"),
      MCP_HOST: "127.0.0.1",
      BRIDGE_URL: bridgeUrl ?? bridge.url,
      ADB_BIN: adb.bin,
    }),
    port: 0,
  };

  const log = createLogger({ silent: true });
  const app = await startServer(cfg, { token, log });
  const base = `http://127.0.0.1:${app.port}`;

  return {
    cfg,
    dir,
    bridge,
    adb,
    base,
    token,
    close: async () => {
      await app.close();
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function rpc(base, body, { token, headers = {} } = {}) {
  const requestHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON (SSE or empty) */
  }
  return { status: response.status, headers: response.headers, text, json };
}

export function initializeMessage(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "harness", version: "1.0.0" },
    },
  };
}
