#!/usr/bin/env node
/**
 * Read a tunnel log and print the public URL, if one is there.
 *
 *   node scripts/tunnel-url.js <quick|ngrok> <log-file> [more-log-files...]
 *
 * Exits 0 and prints the URL, or exits 1 when no URL is present yet. Used by
 * start.sh so the parsing rules live in one tested place instead of in sed.
 */
import { readFileSync } from "node:fs";

import { extractNgrokUrl, extractTunnelUrl } from "../src/tunnel.js";

const [provider, ...files] = process.argv.slice(2);
if (!provider) {
  console.error("usage: node scripts/tunnel-url.js <quick|ngrok> <log-file> [...]");
  process.exit(2);
}

let text = "";
for (const file of files) {
  try {
    text += readFileSync(file, "utf8");
  } catch {
    /* a log that does not exist yet is normal while starting up */
  }
}

const url = provider === "ngrok" ? extractNgrokUrl(text) : extractTunnelUrl(text);
if (!url) process.exit(1);

console.log(url);
