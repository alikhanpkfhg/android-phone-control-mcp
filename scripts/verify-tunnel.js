#!/usr/bin/env node
/**
 * Verify that a public quick-tunnel URL really reaches this MCP server.
 *
 *   node scripts/verify-tunnel.js https://something.trycloudflare.com
 *
 * Exits 0 when the tunnel answers 401 from POST /mcp (reached the server, auth
 * intact), 1 otherwise, and prints the reason. A URL read out of a cloudflared
 * log is not evidence on its own: a hostname can outlive its process and keep
 * answering HTTP 530 from the edge.
 */
import { verifyTunnel } from "../src/tunnel.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/verify-tunnel.js <https://host.trycloudflare.com>");
  process.exit(2);
}

const timeoutMs = Number(process.env.TUNNEL_VERIFY_TIMEOUT_MS || 12000);
const result = await verifyTunnel(url, { timeoutMs });

if (result.ok) {
  console.log(`[ok] tunnel ${result.url} ${result.reason}`);
  process.exit(0);
}

console.log(`[x] tunnel ${result.url || url} is not usable: ${result.reason}`);
console.log("    A stale hostname cannot be repaired; start a new tunnel (sh start.sh).");
process.exit(1);
