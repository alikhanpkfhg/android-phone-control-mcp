import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "android-phone-control-mcp";
export const VERSION = "1.2.0";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8766";
export const DEFAULT_HOME = path.join(os.homedir(), ".android-phone-control-mcp");

export const CONFIRM_MODES = ["auto", "strict", "none"];
export const BRIDGE_INPUT_MODES = ["auto", "adb", "bridge"];
export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"];

export class ConfigError extends Error {
  constructor(message, { variable } = {}) {
    super(message);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

function readInt(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} must be a whole number between ${min} and ${max} (got "${raw}")`,
      { variable: name },
    );
  }
  return value;
}

function readBool(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}")`, { variable: name });
}

function readEnum(env, name, allowed, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new ConfigError(
      `${name} must be one of ${allowed.join(", ")} (got "${raw}")`,
      { variable: name },
    );
  }
  return value;
}

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.includes(normalized);
}

/**
 * Build the server configuration from environment variables.
 *
 * The defaults keep everything on the loopback interface: the MCP server binds
 * 127.0.0.1:8787 and the phone bridge stays on 127.0.0.1:8766. Publishing is
 * done by a tunnel that targets the MCP port only.
 */
export function loadConfig(env = process.env) {
  const home = (env.PHONE_MCP_HOME || "").trim() || DEFAULT_HOME;
  const host = (env.MCP_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = readInt(env, "MCP_PORT", DEFAULT_PORT, { min: 1, max: 65535 });

  const bridgeUrl = ((env.BRIDGE_URL || DEFAULT_BRIDGE_URL).trim() || DEFAULT_BRIDGE_URL).replace(
    /\/+$/,
    "",
  );

  let parsedBridge;
  try {
    parsedBridge = new URL(bridgeUrl);
  } catch {
    throw new ConfigError(`BRIDGE_URL is not a valid URL (got "${bridgeUrl}")`, {
      variable: "BRIDGE_URL",
    });
  }
  if (!/^https?:$/.test(parsedBridge.protocol)) {
    throw new ConfigError(`BRIDGE_URL must start with http:// or https:// (got "${bridgeUrl}")`, {
      variable: "BRIDGE_URL",
    });
  }

  const bridgePort = Number(
    parsedBridge.port || (parsedBridge.protocol === "https:" ? 443 : 80),
  );

  if (bridgePort === port) {
    throw new ConfigError(
      `MCP_PORT (${port}) must differ from the phone bridge port (${bridgePort}); the bridge is local-only and must never be the port that gets tunneled`,
      { variable: "MCP_PORT" },
    );
  }

  const allowRemoteBind = readBool(env, "PHONE_MCP_ALLOW_REMOTE_BIND", false);
  if (!isLoopbackHostname(host) && !allowRemoteBind) {
    throw new ConfigError(
      `MCP_HOST "${host}" is not a loopback address. Refusing to bind publicly; set PHONE_MCP_ALLOW_REMOTE_BIND=1 only if you really mean it`,
      { variable: "MCP_HOST" },
    );
  }

  const warnings = [];
  const bridgeLoopback = isLoopbackHostname(parsedBridge.hostname);
  if (!bridgeLoopback) {
    warnings.push(
      `BRIDGE_URL points at ${parsedBridge.hostname}, which is not loopback. The bridge is meant to run on 127.0.0.1:8766 and must never be published.`,
    );
  }

  const confirmMode = readEnum(env, "PHONE_MCP_CONFIRM", CONFIRM_MODES, "auto");
  const bridgeInput = readEnum(env, "BRIDGE_INPUT", BRIDGE_INPUT_MODES, "auto");
  const protocol = (env.CLOUDFLARED_PROTOCOL || "http2").trim() || "http2";

  return {
    name: SERVER_NAME,
    version: VERSION,
    home,
    host,
    port,
    mcpUrl: `http://${host}:${port}`,
    bridgeUrl,
    bridgePort,
    bridgeLoopback,
    bridgeInput,
    confirmMode,
    adbBin: (env.ADB_BIN || "adb").trim() || "adb",
    adbTimeoutMs: readInt(env, "ADB_TIMEOUT_MS", 20000, { min: 1000, max: 120000 }),
    bridgeTimeoutMs: readInt(env, "BRIDGE_TIMEOUT_MS", 15000, { min: 500, max: 120000 }),
    maxTextLength: readInt(env, "MAX_TEXT_LENGTH", 4000, { min: 1, max: 10000 }),
    maxBodyBytes: readInt(env, "MCP_MAX_BODY_BYTES", 2 * 1024 * 1024, {
      min: 1024,
      max: 32 * 1024 * 1024,
    }),
    screenCacheMs: 60000,
    tokenFile: (env.TOKEN_FILE || "").trim() || path.join(home, "token"),
    logFile: (env.LOG_FILE || "").trim() || path.join(home, "logs", "mcp.log"),
    allowRemoteBind,
    tunnel: { port, protocol },
    warnings,
  };
}
