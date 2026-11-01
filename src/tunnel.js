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

/**
 * Prove that a public quick-tunnel URL actually serves this server.
 *
 * A trycloudflare hostname can outlive the cloudflared process that created it.
 * When that happens the Cloudflare edge keeps answering for the hostname with
 * HTTP 530 ("no live connector"), so the URL looks perfectly well formed while
 * being completely dead. That is why a URL read from the log is not evidence
 * that the tunnel works.
 *
 * Only a 401 from POST /mcp counts as success: it proves the edge reached this
 * server and that the bearer gate is intact. A 200 is treated as failure,
 * because it would mean an unauthenticated endpoint is published.
 */
export async function verifyTunnel(tunnelUrl, { timeoutMs = 12000 } = {}) {
  const url = publicMcpUrl(tunnelUrl);
  if (!url) return { ok: false, status: 0, url: null, reason: "no tunnel URL to verify" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: controller.signal,
    });

    const status = response.status;
    if (status === 401) {
      return { ok: true, status, url, reason: "reachable, bearer token enforced" };
    }
    if (status === 200) {
      return {
        ok: false,
        status,
        url,
        reason: "reachable but accepted a request with no bearer token",
      };
    }
    if (status === 530 || status === 502 || status === 504) {
      return {
        ok: false,
        status,
        url,
        reason: `the Cloudflare edge has no live connector for this hostname (HTTP ${status})`,
      };
    }
    return { ok: false, status, url, reason: `unexpected HTTP ${status}` };
  } catch (error) {
    const reason =
      error?.name === "AbortError"
        ? `timed out after ${timeoutMs} ms`
        : error?.cause?.code || error?.message || "request failed";
    return { ok: false, status: 0, url, reason };
  } finally {
    clearTimeout(timer);
  }
}
