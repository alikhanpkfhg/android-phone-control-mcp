import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export class PhoneError extends Error {
  constructor(message, { code = "PHONE_ERROR", hint } = {}) {
    super(message);
    this.name = "PhoneError";
    this.code = code;
    this.hint = hint;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * `adb shell input text` is parsed by the device shell, so spaces and shell
 * metacharacters have to be escaped. Spaces become %s, which is the convention
 * `input text` itself understands.
 */
export function escapeInputText(text) {
  return String(text).replace(/[\\"'`$&|;<>()*?!~#{}[\] ]/g, (character) =>
    character === " " ? "%s" : `\\${character}`,
  );
}

export function parseAdbDevices(text) {
  const devices = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^List of devices/i.test(trimmed)) continue;
    if (trimmed.startsWith("*")) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    devices.push({ serial, state, detail: rest.join(" ") || undefined });
  }
  return devices;
}

function stripDataUrl(value) {
  const comma = value.indexOf(",");
  if (value.startsWith("data:") && comma !== -1) return value.slice(comma + 1);
  return value;
}

/**
 * The phone driver.
 *
 * Screenshots: the existing Termux bridge (http://127.0.0.1:8766/screenshot) is
 * tried first, then `adb exec-out screencap -p` as a fallback.
 *
 * Input: the bridge is asked first (POST /tap, /swipe, /key, /text, /launch). In
 * "auto" mode a bridge that does not implement those routes is skipped and adb
 * is used instead. adb is the reliable path, because the bridge is only known
 * to serve /health and /screenshot.
 */
export function createPhone(cfg, { log } = {}) {
  let screenCache = null;
  let bridgeInputUnsupported = false;
  let warnedInputFallback = false;

  function translateAdbError(error, args) {
    const command = `adb ${args.join(" ")}`;
    if (error && error.code === "ENOENT") {
      return new PhoneError(
        `adb executable not found (tried "${cfg.adbBin}"). Install Android platform tools: pkg install -y android-tools`,
        {
          code: "ADB_MISSING",
          hint: "Run: pkg install -y android-tools",
        },
      );
    }
    if (error && (error.killed || error.signal || error.code === "ETIMEDOUT")) {
      return new PhoneError(`adb command timed out: ${command}`, { code: "ADB_TIMEOUT" });
    }
    const stderr = String(error?.stderr ?? "").trim();
    const stdout = String(error?.stdout ?? "").trim();
    const detail = (stderr || stdout || error?.message || "")
      .split("\n")
      .slice(0, 3)
      .join(" ")
      .slice(0, 400);
    return new PhoneError(
      `adb command failed: ${command}${detail ? ` -> ${detail}` : ""}`,
      {
        code: "ADB_FAILED",
        hint: "Check `adb devices` shows the phone as `device` and that wireless debugging is still connected.",
      },
    );
  }

  async function adb(args, { timeoutMs, binary = false } = {}) {
    try {
      const result = await execFileAsync(cfg.adbBin, args, {
        timeout: timeoutMs ?? cfg.adbTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? "buffer" : "utf8",
        windowsHide: true,
      });
      const stdout = result.stdout ?? (binary ? Buffer.alloc(0) : "");
      const stderr = result.stderr ?? (binary ? Buffer.alloc(0) : "");
      return {
        stdout,
        stderr,
        text: binary ? "" : `${String(stdout)}${String(stderr)}`,
      };
    } catch (error) {
      throw translateAdbError(error, args);
    }
  }

  async function bridgeRequest(pathname, { method = "GET", body, timeoutMs } = {}) {
    const url = `${cfg.bridgeUrl}${pathname}`;
    const effectiveTimeout = timeoutMs ?? cfg.bridgeTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
      return await fetch(url, {
        method,
        headers:
          body === undefined
            ? { accept: "*/*" }
            : { accept: "*/*", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error?.name === "AbortError"
          ? `timed out after ${effectiveTimeout} ms`
          : error?.cause?.code || error?.message || "request failed";
      throw new PhoneError(
        `phone bridge ${cfg.bridgeUrl}${pathname} unreachable (${reason})`,
        {
          code: "BRIDGE_UNREACHABLE",
          hint: "The bridge runs on 127.0.0.1:8766 in Termux; start it before using the MCP server.",
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function screenshotFromBridge() {
    const response = await bridgeRequest("/screenshot", { method: "GET" });
    if (!response.ok) {
      throw new PhoneError(`bridge /screenshot returned HTTP ${response.status}`, {
        code: "BRIDGE_SCREENSHOT_FAILED",
      });
    }
    const contentType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length === 0) {
      throw new PhoneError("bridge /screenshot returned an empty body", {
        code: "BRIDGE_SCREENSHOT_EMPTY",
      });
    }

    if (contentType === "application/json") {
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new PhoneError("bridge /screenshot returned invalid JSON", {
          code: "BRIDGE_SCREENSHOT_INVALID_JSON",
        });
      }
      const encoded = payload?.base64 || payload?.image || payload?.data || payload?.screenshot;
      if (typeof encoded !== "string" || encoded.trim() === "") {
        throw new PhoneError(
          "bridge /screenshot JSON did not contain base64 image data (expected base64, image, data or screenshot)",
          { code: "BRIDGE_SCREENSHOT_NO_DATA" },
        );
      }
      const buffer = Buffer.from(stripDataUrl(encoded.trim()), "base64");
      const mimeType = sniffImageMime(buffer) || "image/png";
      return { buffer, mimeType, source: "bridge-json" };
    }

    const mimeType = sniffImageMime(raw) || (contentType.startsWith("image/") ? contentType : null);
    if (!mimeType) {
      throw new PhoneError(
        `bridge /screenshot returned non-image content (content-type: ${contentType || "none"})`,
        { code: "BRIDGE_SCREENSHOT_NOT_IMAGE" },
      );
    }
    return { buffer: raw, mimeType, source: "bridge" };
  }

  async function screenshotFromAdb() {
    const { stdout } = await adb(["exec-out", "screencap", "-p"], {
      binary: true,
      timeoutMs: cfg.adbTimeoutMs,
    });
    let buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? []);
    if (!sniffImageMime(buffer) && buffer.includes(Buffer.from("\r\n"))) {
      // Old adb builds translate line endings on `shell`; be forgiving.
      buffer = Buffer.from(buffer.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    }
    if (sniffImageMime(buffer) !== "image/png") {
      throw new PhoneError(
        "adb screencap did not return a PNG image (is the phone authorized in `adb devices`?)",
        { code: "ADB_SCREENSHOT_FAILED" },
      );
    }
    return { buffer, mimeType: "image/png", source: "adb" };
  }

  async function screenshot() {
    const problems = [];
    try {
      return await screenshotFromBridge();
    } catch (error) {
      problems.push(error);
      if (log) log.warn("bridge screenshot failed; falling back to adb", { reason: error.message });
    }
    try {
      return await screenshotFromAdb();
    } catch (error) {
      problems.push(error);
    }
    throw new PhoneError(
      `could not capture a screenshot:\n${problems.map((e) => `- ${e.message}`).join("\n")}`,
      {
        code: "SCREENSHOT_FAILED",
        hint: "Make sure `adb devices` lists your phone as `device`, or that the bridge on 127.0.0.1:8766 is running.",
      },
    );
  }

  async function inputViaBridge(pathname, payload) {
    if (bridgeInputUnsupported) {
      throw new PhoneError(`bridge input endpoint ${pathname} is not available`, {
        code: "BRIDGE_INPUT_UNSUPPORTED",
      });
    }
    const response = await bridgeRequest(pathname, {
      method: "POST",
      body: payload,
      timeoutMs: Math.min(cfg.bridgeTimeoutMs, 5000),
    });
    if (!response.ok) {
      throw new PhoneError(`bridge ${pathname} returned HTTP ${response.status}`, {
        code: "BRIDGE_INPUT_UNSUPPORTED",
      });
    }
    return response;
  }

  function noteInputFallback(error) {
    if (error?.code === "BRIDGE_INPUT_UNSUPPORTED") bridgeInputUnsupported = true;
    if (log && !warnedInputFallback) {
      warnedInputFallback = true;
      log.warn("the phone bridge does not accept input commands; using adb for input", {
        reason: error.message,
      });
    }
  }

  async function runInput({ bridgePath, bridgePayload, adbArgs, action }) {
    if (cfg.bridgeInput !== "adb") {
      try {
        await inputViaBridge(bridgePath, bridgePayload);
        return { via: "bridge", action };
      } catch (error) {
        if (cfg.bridgeInput === "bridge") throw error;
        noteInputFallback(error);
      }
    }
    await adb(adbArgs);
    return { via: "adb", action };
  }

  function tap(x, y) {
    return runInput({
      bridgePath: "/tap",
      bridgePayload: { x, y },
      adbArgs: ["shell", "input", "tap", String(x), String(y)],
      action: "tap",
    });
  }

  function swipe({ x1, y1, x2, y2, durationMs = 300 }) {
    return runInput({
      bridgePath: "/swipe",
      bridgePayload: { x1, y1, x2, y2, duration_ms: durationMs },
      adbArgs: ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)],
      action: "swipe",
    });
  }

  function pressKey(argument) {
    return runInput({
      bridgePath: "/key",
      bridgePayload: { key: argument },
      adbArgs: ["shell", "input", "keyevent", argument],
      action: "key",
    });
  }

  function typeText(text) {
    return runInput({
      bridgePath: "/text",
      bridgePayload: { text },
      adbArgs: ["shell", "input", "text", escapeInputText(text)],
      action: "text",
    });
  }

  async function launchApp(packageName) {
    if (cfg.bridgeInput !== "adb") {
      try {
        await inputViaBridge("/launch", { package: packageName });
        return { via: "bridge", package: packageName };
      } catch (error) {
        if (cfg.bridgeInput === "bridge") throw error;
        noteInputFallback(error);
      }
    }

    const launched = await adb([
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);

    if (!/No activities found/i.test(launched.text)) {
      return { via: "adb", package: packageName };
    }

    const resolved = await adb(["shell", "cmd", "package", "resolve-activity", "--brief", packageName]);
    const component = /([A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+)/.exec(resolved.text)?.[1];
    if (!component) {
      throw new PhoneError(`could not launch "${packageName}": no launcher activity (is it installed?)`, {
        code: "APP_NOT_FOUND",
      });
    }
    await adb(["shell", "am", "start", "-n", component]);
    return { via: "adb", package: packageName, component };
  }

  async function screenSize({ fresh = false } = {}) {
    if (!fresh && screenCache && Date.now() - screenCache.at < cfg.screenCacheMs) {
      return screenCache.value;
    }
    const { text } = await adb(["shell", "wm", "size"], { timeoutMs: 10000 });
    const override = /Override size:\s*(\d+)x(\d+)/i.exec(text);
    const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(text);
    const match = override || physical;
    if (!match) {
      throw new PhoneError(
        `could not read the screen size from \`adb shell wm size\` (output: ${text.trim().slice(0, 200) || "empty"})`,
        { code: "SCREEN_SIZE_UNKNOWN" },
      );
    }
    const value = { width: Number(match[1]), height: Number(match[2]) };
    screenCache = { at: Date.now(), value };
    return value;
  }

  async function tryScreenSize(options) {
    try {
      return await screenSize(options);
    } catch {
      return null;
    }
  }

  async function bridgeHealth() {
    const info = { url: cfg.bridgeUrl, loopback: cfg.bridgeLoopback, ok: false };
    try {
      const response = await bridgeRequest("/health", {
        method: "GET",
        timeoutMs: Math.min(cfg.bridgeTimeoutMs, 5000),
      });
      info.httpStatus = response.status;
      info.ok = response.ok;
      const text = await response.text();
      try {
        info.reported = JSON.parse(text);
      } catch {
        info.reported = text.slice(0, 500);
      }
    } catch (error) {
      info.ok = false;
      info.error = error.message;
    }
    return info;
  }

  async function status() {
    const bridge = await bridgeHealth();

    const adbInfo = { executable: cfg.adbBin, available: false, ready: false };
    try {
      const version = await adb(["version"], { timeoutMs: 5000 });
      adbInfo.available = true;
      adbInfo.version = (version.text.trim().split("\n")[0] || "").slice(0, 200);
      const devices = await adb(["devices"], { timeoutMs: 8000 });
      adbInfo.devices = parseAdbDevices(devices.text);
      adbInfo.ready = adbInfo.devices.some((device) => device.state === "device");
    } catch (error) {
      adbInfo.error = error.message;
      if (error.code === "ADB_MISSING") adbInfo.hint = error.hint;
    }

    const screen = adbInfo.ready ? await tryScreenSize() : null;

    return {
      ok: Boolean(bridge.ok || adbInfo.ready),
      checkedAt: new Date().toISOString(),
      bridge,
      adb: adbInfo,
      screen,
      notes: [
        "The phone bridge (port 8766) is local-only and is never tunneled; only the MCP server (port 8787) is published.",
      ],
    };
  }

  return {
    status,
    screenshot,
    tap,
    swipe,
    pressKey,
    typeText,
    launchApp,
    screenSize,
    tryScreenSize,
    escapeInputText,
  };
}
