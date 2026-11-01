#!/usr/bin/env node
/**
 * Live smoke test against a running android-phone-control-mcp server.
 *
 *   node scripts/selftest.js
 *
 * It reads the token from PHONE_MCP_HOME/token (or PHONE_MCP_TOKEN) and walks
 * the same checks the CI suite performs, but against the real installation:
 * initialization, tools/list, authentication, phone_status, phone_screenshot,
 * invalid requests, and the rule that port 8766 is never the tunnel target.
 */
import { loadConfig } from "../src/config.js";
import { readToken } from "../src/token.js";
import { publicMcpUrl, tunnelTarget } from "../src/tunnel.js";

const cfg = loadConfig(process.env);
const token = (process.env.PHONE_MCP_TOKEN || "").trim() || readToken(cfg.tokenFile);

let failures = 0;
let passes = 0;

function pass(name, detail = "") {
  passes += 1;
  console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
}

function failCheck(name, detail = "") {
  failures += 1;
  console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail === undefined ? "" : String(detail));
  } catch (error) {
    failCheck(name, error?.message || String(error));
  }
}

if (!token) {
  console.error(`no bearer token found at ${cfg.tokenFile}; run install.sh first`);
  process.exit(2);
}

const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
const base = `http://${host}:${cfg.port}`;

async function call(body, { withToken = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (withToken) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, text, json };
}

await check("server /health answers", async () => {
  const response = await fetch(`${base}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== "ok") throw new Error(`unexpected status ${body.status}`);
  return `v${body.version}`;
});

await check("MCP rejects a request without a token", async () => {
  const response = await call(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { withToken: false },
  );
  if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
  return "401";
});

await check("MCP initialization succeeds with the token", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "selftest", version: "1.0.0" },
    },
  });
  if (!response.json?.result) throw new Error(response.text.slice(0, 200));
  return `${response.json.result.serverInfo.name} ${response.json.result.protocolVersion}`;
});

await check("tools/list returns the phone tools", async () => {
  const response = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = (response.json?.result?.tools || []).map((tool) => tool.name);
  const expected = [
    "phone_status",
    "phone_screenshot",
    "phone_tap",
    "phone_swipe",
    "phone_press_key",
    "phone_launch_app",
    "phone_type_text",
  ];
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return `${names.length} tools`;
});

await check("phone_status reaches the bridge and adb", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "phone_status", arguments: {} },
  });
  const result = response.json?.result;
  if (!result || result.isError) throw new Error(result?.content?.[0]?.text || "no result");
  const status = JSON.parse(result.content[0].text);
  if (!status.adb?.ready && !status.bridge?.ok) {
    throw new Error("neither adb nor the bridge is reachable");
  }
  const screen = status.screen ? `${status.screen.width}x${status.screen.height}` : "unknown";
  return `bridge=${status.bridge?.ok} adb=${status.adb?.ready} screen=${screen}`;
});

await check("phone_screenshot returns image content", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "phone_screenshot", arguments: {} },
  });
  const result = response.json?.result;
  if (!result || result.isError) throw new Error(result?.content?.[0]?.text || "no result");
  const image = result.content.find((block) => block.type === "image");
  if (!image) throw new Error("no image content block in the response");
  const bytes = Buffer.from(image.data, "base64").length;
  if (bytes < 100) throw new Error(`screenshot looks empty (${bytes} bytes)`);
  return `${image.mimeType}, ${bytes} bytes`;
});

await check("invalid coordinates are rejected", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "phone_tap", arguments: { x: -1, y: -1 } },
  });
  const result = response.json?.result;
  if (!result?.isError) throw new Error("expected a tool error");
  return result.content[0].text.slice(0, 60);
});

await check("typing without confirmation is refused", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "phone_type_text", arguments: { text: "selftest" } },
  });
  const result = response.json?.result;
  if (cfg.confirmMode === "none") return "confirmation disabled by configuration";
  if (!result?.isError) throw new Error("expected the confirmation gate to refuse");
  return "refused";
});

await check("unknown tools and methods are rejected", async () => {
  const unknownTool = await call({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "run_shell", arguments: { command: "id" } },
  });
  if (unknownTool.json?.error?.code !== -32602) throw new Error("unknown tool was not rejected");
  const unknownMethod = await call({ jsonrpc: "2.0", id: 9, method: "resources/list" });
  if (unknownMethod.json?.error?.code !== -32601) throw new Error("unknown method was not rejected");
  return "no shell tool exists";
});

await check("the tunnel target is the MCP port, never the bridge port", async () => {
  const target = tunnelTarget(cfg);
  if (String(cfg.bridgePort) === String(cfg.port)) throw new Error("bridge port equals MCP port");
  if (!target.endsWith(`:${cfg.port}`)) throw new Error(`unexpected tunnel target ${target}`);
  return target;
});

const tunnelUrlFile = `${cfg.home}/tunnel-url.txt`;
const { readFileSync } = await import("node:fs");
let tunnelUrl = null;
try {
  tunnelUrl = readFileSync(tunnelUrlFile, "utf8").trim();
} catch {
  /* not started yet */
}

if (tunnelUrl) {
  await check("the public tunnel exposes /mcp with auth required", async () => {
    const response = await fetch(publicMcpUrl(tunnelUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }),
    });
    if (response.status !== 401) throw new Error(`expected 401 through the tunnel, got ${response.status}`);
    return `${tunnelUrl} refused an anonymous request`;
  });
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
process.exit(0);
