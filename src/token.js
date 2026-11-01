import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MIN_USABLE_TOKEN_LENGTH = 20;

/**
 * 32 random bytes rendered as base64url: 43 URL-safe characters, no padding.
 * The token is generated locally on first install and never committed.
 */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function readToken(tokenFile) {
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return token.length >= MIN_USABLE_TOKEN_LENGTH ? token : null;
  } catch {
    return null;
  }
}

/**
 * Create the bearer token file if it does not exist yet, with 0600 permissions.
 * Existing good tokens are always reused so restarts keep working.
 */
export function ensureTokenFile(tokenFile) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });

  const existing = readToken(tokenFile);
  if (existing) {
    try {
      fs.chmodSync(tokenFile, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return { token: existing, created: false };
  }

  const token = generateToken();
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch {
    /* best effort */
  }
  return { token, created: true };
}

/**
 * Constant-time comparison. Both sides are hashed first so that differing
 * lengths do not leak timing information.
 */
export function safeEqual(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (expected.length === 0 || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(expected, "utf8").digest();
  const b = crypto.createHash("sha256").update(provided, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export function maskToken(token) {
  if (typeof token !== "string" || token.length === 0) return "***";
  if (token.length <= 12) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
