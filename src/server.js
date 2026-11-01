import http from "node:http";

import { isAuthorized, parseBearer } from "./auth.js";
import { createLogger } from "./log.js";
import { dispatch, jsonRpcError } from "./mcp.js";
import { createPhone } from "./phone.js";
import { createTools } from "./tools.js";

function normalizePath(pathname) {
  const trimmed = String(pathname || "/").replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendEventStream(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  res.end();
}

function setBaseHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function streamOnly(req) {
  const accept = String(req.headers.accept || "");
  if (!accept) return false;
  const hasSse = accept.includes("text/event-stream");
  const hasJson = accept.includes("application/json") || accept.includes("*/*");
  return hasSse && !hasJson;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("payload too large");
        error.code = "TOO_LARGE";
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleRequest(req, res, ctx) {
  const { cfg, log } = ctx;

  let url;
  try {
    url = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    setBaseHeaders(res);
    return sendJson(res, 400, { error: "bad_request" });
  }
  const pathname = normalizePath(url.pathname);
  setBaseHeaders(res);

  if (pathname === "/health") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }
    if (req.method === "HEAD") {
      res.writeHead(200);
      return res.end();
    }
    return sendJson(res, 200, {
      status: "ok",
      service: cfg.name,
      version: cfg.version,
      mcp: "POST /mcp",
      auth: "bearer",
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
    });
  }

  if (pathname === "/") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }
    if (req.method === "HEAD") {
      res.writeHead(200);
      return res.end();
    }
    return sendJson(res, 200, {
      service: cfg.name,
      version: cfg.version,
      endpoints: { health: "GET /health", mcp: "POST /mcp (Authorization: Bearer <token>)" },
    });
  }

  if (pathname !== "/mcp") {
    return sendJson(res, 404, { error: "not_found", path: pathname });
  }

  if (!ctx.token) {
    log.error("refusing to serve /mcp: no bearer token is configured");
    return sendJson(res, 500, jsonRpcError(null, -32603, "Server misconfigured: no bearer token"));
  }

  if (!isAuthorized(req, ctx.token)) {
    log.warn("rejected unauthenticated MCP request", {
      method: req.method,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
      scheme: parseBearer(req.headers.authorization) ? "bearer" : "none",
    });
    return sendJson(
      res,
      401,
      jsonRpcError(null, -32001, 'Unauthorized: send "Authorization: Bearer <token>"'),
      { "WWW-Authenticate": `Bearer realm="${cfg.name}"` },
    );
  }

  if (req.method === "GET" || req.method === "DELETE") {
    return sendJson(
      res,
      405,
      jsonRpcError(null, -32000, `${req.method} /mcp is not supported; POST a JSON-RPC message instead`),
      { Allow: "POST" },
    );
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, jsonRpcError(null, -32000, "Method Not Allowed"), { Allow: "POST" });
  }

  let raw;
  try {
    raw = await readBody(req, cfg.maxBodyBytes);
  } catch (error) {
    if (error && error.code === "TOO_LARGE") {
      return sendJson(res, 413, jsonRpcError(null, -32600, "Request body too large"));
    }
    return sendJson(res, 400, jsonRpcError(null, -32700, "Parse error: could not read the request body"));
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendJson(res, 400, jsonRpcError(null, -32700, "Parse error: body is not valid JSON"));
  }

  const batch = Array.isArray(payload);
  const messages = batch ? payload : [payload];
  if (batch && messages.length === 0) {
    return sendJson(res, 400, jsonRpcError(null, -32600, "Invalid Request: empty batch"));
  }

  const responses = [];
  for (const message of messages) {
    const response = await dispatch(message, ctx);
    if (response) responses.push(response);
  }

  if (responses.length === 0) {
    res.writeHead(202);
    return res.end();
  }

  const body = batch ? responses : responses[0];
  if (streamOnly(req)) return sendEventStream(res, body);
  return sendJson(res, 200, body);
}

export function createApp(cfg, { token, log, phone, tools } = {}) {
  const logger = log ?? createLogger({ file: cfg.logFile });
  const phoneApi = phone ?? createPhone(cfg, { log: logger });
  const toolset = tools ?? createTools(cfg, phoneApi);

  const ctx = {
    cfg,
    token,
    log: logger,
    phone: phoneApi,
    tools: toolset,
    startedAt: Date.now(),
    client: null,
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((error) => {
      logger.error("unhandled request error", { error: error?.message, stack: error?.stack });
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(null, -32603, "Internal error"));
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  });

  server.on("clientError", (error, socket) => {
    logger.debug("client error", { error: error?.message });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return { server, ctx, log: logger, phone: phoneApi, tools: toolset };
}

/**
 * Start the MCP HTTP server and resolve once it is listening.
 */
export async function startServer(cfg, options = {}) {
  const app = createApp(cfg, options);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      app.server.removeListener("error", onError);
      reject(error);
    };
    app.server.once("error", onError);
    app.server.listen(cfg.port, cfg.host, () => {
      app.server.removeListener("error", onError);
      resolve();
    });
  });

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : cfg.port;
  app.log.info("MCP server listening", {
    url: `http://${cfg.host}:${port}/mcp`,
    bridge: cfg.bridgeUrl,
    confirmMode: cfg.confirmMode,
  });

  return {
    server: app.server,
    ctx: app.ctx,
    port,
    host: cfg.host,
    close: () =>
      new Promise((resolve) => {
        app.server.close(() => resolve());
      }),
  };
}
