import assert from "node:assert/strict";
import test from "node:test";

import {
  TEST_TOKEN,
  TINY_PNG_BASE64,
  initializeMessage,
  rpc,
  startHarness,
  unusedPort,
} from "./helpers/harness.js";

const TOOL_NAMES = [
  "phone_status",
  "phone_screenshot",
  "phone_tap",
  "phone_swipe",
  "phone_press_key",
  "phone_launch_app",
  "phone_type_text",
];

test("health endpoint answers without a token and leaks nothing", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.auth, "bearer");
  assert.equal(JSON.stringify(body).includes(h.token), false);
});

test("every MCP request needs the bearer token", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const anonymous = await rpc(h.base, initializeMessage());
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, -32001);
  assert.match(anonymous.json.error.message, /Unauthorized/);

  const wrong = await rpc(h.base, initializeMessage(), { token: "not-the-token-at-all" });
  assert.equal(wrong.status, 401);

  const basic = await rpc(h.base, initializeMessage(), {
    token: null,
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(basic.status, 401);

  const toolsWithoutToken = await rpc(h.base, { jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.equal(toolsWithoutToken.status, 401);

  const authorized = await rpc(h.base, initializeMessage(), { token: h.token });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.json.jsonrpc, "2.0");
});

test("initialize reports capabilities, server info and safety instructions", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await rpc(h.base, initializeMessage(), { token: h.token });
  const result = response.json.result;
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "android-phone-control-mcp");
  assert.equal(result.capabilities.tools.listChanged, false);
  assert.match(result.instructions, /confirm/i);
  assert.match(result.instructions, /never/i);
});

test("initialize echoes an older supported protocol version", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const message = initializeMessage(2);
  message.params.protocolVersion = "2024-11-05";
  const response = await rpc(h.base, message, { token: h.token });
  assert.equal(response.json.result.protocolVersion, "2024-11-05");

  message.params.protocolVersion = "1999-01-01";
  const fallback = await rpc(h.base, message, { token: h.token });
  assert.equal(fallback.json.result.protocolVersion, "2025-06-18");
});

test("tools/list exposes exactly the seven phone tools with schemas", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await rpc(h.base, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { token: h.token });
  const tools = response.json.result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 20);
  }
  const tap = tools.find((tool) => tool.name === "phone_tap");
  assert.deepEqual(tap.inputSchema.required, ["x", "y"]);
  assert.equal(tap.annotations.readOnlyHint, false);
  assert.equal(tools.find((tool) => tool.name === "phone_status").annotations.readOnlyHint, true);
});

test("phone_status reports bridge, adb, device and screen size", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await rpc(
    h.base,
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "phone_status", arguments: {} } },
    { token: h.token },
  );
  const result = response.json.result;
  assert.notEqual(result.isError, true);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.ok, true);
  assert.equal(status.bridge.ok, true);
  assert.equal(status.adb.ready, true);
  assert.equal(status.adb.devices[0].serial, "emulator-5554");
  assert.deepEqual(status.screen, { width: 720, height: 1612 });
  assert.match(status.notes.join(" "), /never tunneled/);
});

test("phone_screenshot returns real MCP image content from the bridge", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "phone_screenshot", arguments: {} },
    },
    { token: h.token },
  );
  const result = response.json.result;
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/png");
  assert.deepEqual(
    Buffer.from(result.content[0].data, "base64"),
    Buffer.from(TINY_PNG_BASE64, "base64"),
    "the image content must be the bridge's PNG, byte for byte",
  );
  assert.match(result.content[1].text, /bridge/);
});

test("phone_screenshot accepts base64 JSON from the bridge", async (t) => {
  const h = await startHarness({ bridgeOptions: "json" });
  t.after(() => h.close());

  const response = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "phone_screenshot", arguments: {} },
    },
    { token: h.token },
  );
  const result = response.json.result;
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].mimeType, "image/png");
  assert.match(result.content[1].text, /bridge-json/);
});

test("phone_screenshot falls back to adb when the bridge is down", async (t) => {
  const port = await unusedPort();
  const h = await startHarness({ bridgeUrl: `http://127.0.0.1:${port}` });
  t.after(() => h.close());

  const response = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "phone_screenshot", arguments: {} },
    },
    { token: h.token },
  );
  const result = response.json.result;
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].type, "image");
  assert.match(result.content[1].text, /adb/);

  const status = await rpc(
    h.base,
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "phone_status", arguments: {} } },
    { token: h.token },
  );
  const parsed = JSON.parse(status.json.result.content[0].text);
  assert.equal(parsed.bridge.ok, false);
  assert.equal(parsed.adb.ready, true);
  assert.equal(parsed.ok, true);
});

test("phone_tap validates coordinates and reaches the device", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const negative = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: -5, y: 10 } },
    },
    { token: h.token },
  );
  assert.equal(negative.json.result.isError, true);
  assert.match(negative.json.result.content[0].text, /Invalid argument/);

  const absurd = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 999999, y: 10 } },
    },
    { token: h.token },
  );
  assert.equal(absurd.json.result.isError, true);

  const offScreen = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 5000, y: 5000 } },
    },
    { token: h.token },
  );
  assert.equal(offScreen.json.result.isError, true);
  assert.match(offScreen.json.result.content[0].text, /720x1612/);

  const missing = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 10 } },
    },
    { token: h.token },
  );
  assert.equal(missing.json.result.isError, true);
  assert.match(missing.json.result.content[0].text, /"y" is required/);

  const unknownArg = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 10, y: 10, shell: "reboot" } },
    },
    { token: h.token },
  );
  assert.equal(unknownArg.json.result.isError, true);

  const ok = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 100, y: 200 } },
    },
    { token: h.token },
  );
  assert.notEqual(ok.json.result.isError, true);
  assert.match(h.adb.log(), /shell input tap 100 200/);
});

test("phone_swipe and phone_launch_app validate and execute", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const swipe = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "phone_swipe", arguments: { x1: 100, y1: 800, x2: 100, y2: 200, duration_ms: 250 } },
    },
    { token: h.token },
  );
  assert.notEqual(swipe.json.result.isError, true);
  assert.match(h.adb.log(), /shell input swipe 100 800 100 200 250/);

  const badDuration = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "phone_swipe", arguments: { x1: 1, y1: 1, x2: 2, y2: 2, duration_ms: 10 } },
    },
    { token: h.token },
  );
  assert.equal(badDuration.json.result.isError, true);

  const launch = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "phone_launch_app", arguments: { package: "com.android.settings" } },
    },
    { token: h.token },
  );
  assert.notEqual(launch.json.result.isError, true);
  assert.match(h.adb.log(), /monkey -p com\.android\.settings/);

  const badPackage = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "phone_launch_app", arguments: { package: "rm -rf /" } },
    },
    { token: h.token },
  );
  assert.equal(badPackage.json.result.isError, true);
});

test("confirmation is enforced for typing and for pressing ENTER", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const typeWithoutConfirm = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "phone_type_text", arguments: { text: "hello" } },
    },
    { token: h.token },
  );
  assert.equal(typeWithoutConfirm.json.result.isError, true);
  assert.match(typeWithoutConfirm.json.result.content[0].text, /Confirmation required/);

  const typeWithConfirm = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "phone_type_text", arguments: { text: "hello world", confirm: true } },
    },
    { token: h.token },
  );
  assert.notEqual(typeWithConfirm.json.result.isError, true);
  assert.match(h.adb.log(), /shell input text hello%sworld/);

  const enterWithoutConfirm = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "phone_press_key", arguments: { key: "ENTER" } },
    },
    { token: h.token },
  );
  assert.equal(enterWithoutConfirm.json.result.isError, true);
  assert.match(enterWithoutConfirm.json.result.content[0].text, /Confirmation required/);

  const enterWithConfirm = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "phone_press_key", arguments: { key: "ENTER", confirm: true } },
    },
    { token: h.token },
  );
  assert.notEqual(enterWithConfirm.json.result.isError, true);
  assert.match(h.adb.log(), /shell input keyevent KEYCODE_ENTER/);

  const home = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "phone_press_key", arguments: { key: "home" } },
    },
    { token: h.token },
  );
  assert.notEqual(home.json.result.isError, true);
  assert.match(h.adb.log(), /shell input keyevent KEYCODE_HOME/);

  const badKey = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: { name: "phone_press_key", arguments: { key: "rm -rf /" } },
    },
    { token: h.token },
  );
  assert.equal(badKey.json.result.isError, true);
});

test("strict confirmation mode gates every mutating tool", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  h.cfg.confirmMode = "strict";
  const tap = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 10, y: 10 } },
    },
    { token: h.token },
  );
  assert.equal(tap.json.result.isError, true);
  assert.match(tap.json.result.content[0].text, /Confirmation required/);

  const screenshot = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "phone_screenshot", arguments: {} },
    },
    { token: h.token },
  );
  assert.notEqual(screenshot.json.result.isError, true, "read-only tools never need confirmation");

  h.cfg.confirmMode = "none";
  const ungated = await rpc(
    h.base,
    {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "phone_tap", arguments: { x: 10, y: 10 } },
    },
    { token: h.token },
  );
  assert.notEqual(ungated.json.result.isError, true);
});

test("invalid requests are rejected with JSON-RPC errors", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const badJson = await rpc(h.base, "{not json", { token: h.token });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, -32700);

  const notJsonRpc = await rpc(h.base, { jsonrpc: "2.0", id: 50 }, { token: h.token });
  assert.equal(notJsonRpc.json.error.code, -32600);

  const unknownMethod = await rpc(
    h.base,
    { jsonrpc: "2.0", id: 51, method: "resources/list" },
    { token: h.token },
  );
  assert.equal(unknownMethod.json.error.code, -32601);

  const unknownTool = await rpc(
    h.base,
    { jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "run_shell", arguments: {} } },
    { token: h.token },
  );
  assert.equal(unknownTool.json.error.code, -32602);
  assert.match(unknownTool.json.error.message, /Unknown tool/);

  const badArguments = await rpc(
    h.base,
    { jsonrpc: "2.0", id: 53, method: "tools/call", params: { name: "phone_tap", arguments: "nope" } },
    { token: h.token },
  );
  assert.equal(badArguments.json.error.code, -32602);

  const getMcp = await fetch(`${h.base}/mcp`, {
    headers: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(getMcp.status, 405);

  const deleteMcp = await fetch(`${h.base}/mcp`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(deleteMcp.status, 405);

  const unknownPath = await fetch(`${h.base}/shell`);
  assert.equal(unknownPath.status, 404);
});

test("notifications get 202 and batches get an array", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const notification = await rpc(
    h.base,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { token: h.token },
  );
  assert.equal(notification.status, 202);
  assert.equal(notification.text, "");

  const batch = await rpc(
    h.base,
    [
      { jsonrpc: "2.0", id: 60, method: "ping" },
      { jsonrpc: "2.0", id: 61, method: "tools/list" },
    ],
    { token: h.token },
  );
  assert.equal(batch.status, 200);
  assert.ok(Array.isArray(batch.json));
  assert.equal(batch.json.length, 2);
  assert.deepEqual(batch.json[0].result, {});
});

test("clients that only accept SSE get an event stream", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${h.token}`,
    },
    body: JSON.stringify(initializeMessage(70)),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /^event: message\ndata: \{/);
  const payload = JSON.parse(text.split("\n")[1].replace(/^data: /, ""));
  assert.equal(payload.result.serverInfo.name, "android-phone-control-mcp");
});
