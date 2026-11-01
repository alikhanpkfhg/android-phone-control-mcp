import {
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  VERSION,
} from "./config.js";
import { ValidationError } from "./validate.js";

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export const INSTRUCTIONS = [
  "This server controls a real Android phone that the user owns (a TECNO SPARK 20 on Android 13), through a local Termux bridge and adb.",
  "",
  "How to work with it:",
  "- Call phone_status first to confirm the bridge and adb are reachable and learn the screen size.",
  "- Take a phone_screenshot before acting, and again after every mutating call, to see what actually changed.",
  "- Coordinates are device pixels, 0,0 at the top-left of the screenshot.",
  "- Prefer phone_launch_app over tapping the app drawer.",
  "",
  "Safety rules you must follow:",
  "- Never perform payments, purchases, account deletion, sending messages, granting permissions, accepting terms or any other irreversible action without explicit user confirmation.",
  "- phone_type_text always needs \"confirm\": true, and phone_press_key with ENTER needs it too. Pass confirm true only after the user said yes.",
  "- This server has no shell tool: do not try to run arbitrary commands through it.",
  "- If the user asks for something that looks destructive, describe what you are about to do and wait for their answer.",
].join("\n");

export function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

function handleInitialize(params, ctx) {
  const requested =
    params && typeof params === "object" ? params.protocolVersion : undefined;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;

  const client = {
    name: params?.clientInfo?.name,
    version: params?.clientInfo?.version,
    protocolVersion,
  };
  ctx.client = client;
  ctx.log.info("initialize", client);

  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, title: "Android Phone Control MCP", version: VERSION },
    instructions: INSTRUCTIONS,
  };
}

function normalizeToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const cleaned = content
    .filter((block) => block && typeof block === "object")
    .map((block) => {
      if (block.type === "image") {
        return { type: "image", data: String(block.data ?? ""), mimeType: String(block.mimeType ?? "image/png") };
      }
      return { type: "text", text: String(block.text ?? "") };
    });
  const payload = { content: cleaned };
  if (result?.isError === true) payload.isError = true;
  if (result?.structuredContent !== undefined) payload.structuredContent = result.structuredContent;
  return payload;
}

async function handleToolsCall(params, ctx) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new RpcError(-32602, "Invalid params: expected an object");
  }
  const { name } = params;
  if (typeof name !== "string" || name === "") {
    throw new RpcError(-32602, "Invalid params: 'name' must be a non-empty string");
  }
  const tool = ctx.tools.get(name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);

  let args = params.arguments;
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new RpcError(-32602, "Invalid params: 'arguments' must be an object");
  }

  try {
    const result = await tool.handler(args);
    return normalizeToolResult(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        content: [{ type: "text", text: `Invalid argument: ${error.message}` }],
        isError: true,
      };
    }
    if (error?.code === "CONFIRMATION_REQUIRED") {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    ctx.log.warn("tool call failed", { tool: name, error: error?.message });
    const hint = error?.hint ? ` ${error.hint}` : "";
    return {
      content: [
        {
          type: "text",
          text: `${error?.message || "tool failed"}${hint}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Dispatch one JSON-RPC message. Returns the response object, or null for
 * notifications (which get no body).
 */
export async function dispatch(message, ctx) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const hasId =
    Object.prototype.hasOwnProperty.call(message, "id") &&
    message.id !== null &&
    message.id !== undefined;

  const method = message.method;
  if (typeof method !== "string") {
    const isResponse = message.result !== undefined || message.error !== undefined;
    if (isResponse) return null;
    return hasId ? jsonRpcError(message.id, -32600, "Invalid Request: missing method") : null;
  }

  if (!hasId) {
    // notifications/initialized, notifications/cancelled, notifications/...
    ctx.log.debug("notification", { method });
    return null;
  }

  const id = message.id;
  const params = message.params;

  try {
    switch (method) {
      case "initialize":
        return jsonRpcResult(id, handleInitialize(params, ctx));
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: ctx.tools.list() });
      case "tools/call":
        return jsonRpcResult(id, await handleToolsCall(params, ctx));
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) {
      return jsonRpcError(id, error.code, error.message, error.data);
    }
    ctx.log.error("request failed", { method, error: error?.message, stack: error?.stack });
    return jsonRpcError(id, -32603, "Internal error", { detail: error?.message });
  }
}
