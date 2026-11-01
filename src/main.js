#!/usr/bin/env node
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { startServer } from "./server.js";
import { ensureTokenFile, maskToken } from "./token.js";

async function main() {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(78);
    }
    throw error;
  }

  const log = createLogger({ file: cfg.logFile, level: process.env.LOG_LEVEL || "info" });
  for (const warning of cfg.warnings) log.warn(warning);

  const { token, created } = ensureTokenFile(cfg.tokenFile);
  if (created) log.warn(`generated a new bearer token at ${cfg.tokenFile}`);

  log.info(`${cfg.name} v${cfg.version} starting`, {
    url: `${cfg.mcpUrl}/mcp`,
    token: maskToken(token),
    bridge: cfg.bridgeUrl,
  });
  log.info(`the phone bridge ${cfg.bridgeUrl} is used from localhost only and is never tunneled`);

  const app = await startServer(cfg, { token, log });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  return app;
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
