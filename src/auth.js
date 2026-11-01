import { safeEqual } from "./token.js";

/**
 * Read the bearer token out of an Authorization header value.
 * Returns null when the header is absent or uses another scheme.
 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

/**
 * Every MCP request must carry `Authorization: Bearer <token>` matching the
 * locally generated token. Nothing else is accepted: no query strings, no
 * cookies, no anonymous access.
 */
export function isAuthorized(request, expectedToken) {
  if (!request || !request.headers) return false;
  const provided = parseBearer(request.headers.authorization);
  if (!provided) return false;
  return safeEqual(expectedToken, provided);
}
