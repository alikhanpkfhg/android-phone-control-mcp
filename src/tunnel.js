import { ConfigError } from "./config.js";

/**
 * Tunnel helpers.
 *
 * The only port that may ever be published is the MCP server port. The phone
 * bridge (127.0.0.1:8766) must stay local, so both the config and these helpers
 * refuse to build a tunnel that points at it.
 */
export function tunnelTarget(cfg) {
  const port = cfg.tunnel?.port ?? cfg.port;
  if (port === cfg.bridgePort) {
    throw new ConfigError(
      `refusing to tunnel the phone bridge port (${port}); only the MCP server may be published`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

export function buildTunnelArgs(cfg) {
  return [
    "tunnel",
    "--url",
    tunnelTarget(cfg),
    "--no-autoupdate",
    "--protocol",
    cfg.tunnel?.protocol || "http2",
  ];
}

export function extractTunnelUrl(text) {
  const matches = String(text || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return matches ? matches[matches.length - 1] : null;
}

export function publicMcpUrl(tunnelUrl) {
  if (!tunnelUrl) return null;
  return `${String(tunnelUrl).replace(/\/+$/, "")}/mcp`;
}
