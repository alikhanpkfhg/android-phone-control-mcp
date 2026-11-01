import {
  ValidationError,
  assertKnownKeys,
  assertWithinScreen,
  booleanArg,
  coordinateArg,
  integerArg,
  normalizeKey,
  stringArg,
  validatePackageName,
  validateText,
} from "./validate.js";

export const TOOL_NAMES = [
  "phone_status",
  "phone_screenshot",
  "phone_tap",
  "phone_swipe",
  "phone_press_key",
  "phone_launch_app",
  "phone_type_text",
];

export const MUTATING_TOOL_NAMES = [
  "phone_tap",
  "phone_swipe",
  "phone_press_key",
  "phone_launch_app",
  "phone_type_text",
];

export class ConfirmationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfirmationRequiredError";
    this.code = "CONFIRMATION_REQUIRED";
  }
}

const AFTER_ACTION = "Call phone_screenshot afterwards to verify what changed.";

const CONFIRM_PROPERTY = {
  type: "boolean",
  description:
    "Human-in-the-loop acknowledgement. Set it to true only after the user explicitly confirmed the action. Required for phone_type_text, and for phone_press_key with ENTER.",
};

/**
 * Confirmation policy.
 *
 * auto   (default) phone_type_text, and phone_press_key(ENTER) must be
 *        confirmed: they are how an assistant sends messages, submits forms,
 *        spends money or deletes an account.
 * strict every mutating tool (all input tools) must be confirmed.
 * none   no server side gate; the model is trusted to ask on its own.
 */
function requiresConfirmation(cfg, name, args) {
  if (cfg.confirmMode === "none") return false;
  if (cfg.confirmMode === "strict") return MUTATING_TOOL_NAMES.includes(name);
  if (name === "phone_type_text") return true;
  if (name === "phone_press_key") {
    let key;
    try {
      key = normalizeKey(args?.key);
    } catch {
      return false;
    }
    return key.name === "ENTER";
  }
  return false;
}

function gateConfirmation(cfg, name, args) {
  if (!requiresConfirmation(cfg, name, args)) return;
  if (booleanArg(args, "confirm", { fallback: false })) return;
  const reason =
    name === "phone_type_text"
      ? "typing text can send messages, enter credentials or confirm a purchase"
      : "pressing ENTER can submit a form, send a message or approve a payment";
  throw new ConfirmationRequiredError(
    `Confirmation required: ${reason}. Ask the user first, then call again with "confirm": true.`,
  );
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

export function createTools(cfg, phone) {
  const definitions = [
    {
      name: "phone_status",
      title: "Phone status",
      description:
        "Report whether the local phone bridge (127.0.0.1:8766) and adb are reachable, which device is attached, and the current screen size. Read-only and safe to call at the start of every session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => textResult(JSON.stringify(await phone.status(), null, 2)),
    },
    {
      name: "phone_screenshot",
      title: "Phone screenshot",
      description:
        "Capture the phone's current screen and return it as real MCP image content (normally PNG). Uses the existing Termux bridge first and falls back to `adb exec-out screencap -p`. Read-only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => {
        const shot = await phone.screenshot();
        const screen = await phone.tryScreenSize();
        const size = `${shot.buffer.length} bytes, ${shot.mimeType}`;
        const geometry = screen ? ` on a ${screen.width}x${screen.height} screen` : "";
        return {
          content: [
            {
              type: "image",
              data: shot.buffer.toString("base64"),
              mimeType: shot.mimeType,
            },
            {
              type: "text",
              text: `Screenshot captured via ${shot.source} (${size})${geometry}. Coordinates for phone_tap/phone_swipe are pixels of this image.`,
            },
          ],
        };
      },
    },
    {
      name: "phone_tap",
      title: "Tap the screen",
      description:
        "Tap one point of the phone screen, in device pixels. Returns how the command was delivered (bridge or adb). " +
        AFTER_ACTION,
      inputSchema: {
        type: "object",
        properties: {
          x: {
            type: "integer",
            minimum: 0,
            maximum: 20000,
            description: "Horizontal pixel coordinate; 0 is the left edge.",
          },
          y: {
            type: "integer",
            minimum: 0,
            maximum: 20000,
            description: "Vertical pixel coordinate; 0 is the top edge.",
          },
          confirm: CONFIRM_PROPERTY,
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args) => {
        assertKnownKeys(args, ["x", "y", "confirm"]);
        const x = coordinateArg(args, "x");
        const y = coordinateArg(args, "y");
        gateConfirmation(cfg, "phone_tap", args);
        const screen = await phone.tryScreenSize();
        assertWithinScreen({ x, y }, screen, "tap point");
        const result = await phone.tap(x, y);
        return textResult(`Tapped (${x}, ${y}) via ${result.via}. ${AFTER_ACTION}`);
      },
    },
    {
      name: "phone_swipe",
      title: "Swipe the screen",
      description:
        "Swipe from one point to another, in device pixels. Use it for scrolling, dismissing sheets and unlocking. " +
        AFTER_ACTION,
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "integer", minimum: 0, maximum: 20000, description: "Start x in pixels." },
          y1: { type: "integer", minimum: 0, maximum: 20000, description: "Start y in pixels." },
          x2: { type: "integer", minimum: 0, maximum: 20000, description: "End x in pixels." },
          y2: { type: "integer", minimum: 0, maximum: 20000, description: "End y in pixels." },
          duration_ms: {
            type: "integer",
            minimum: 50,
            maximum: 5000,
            description: "How long the gesture takes, in milliseconds. Default 300.",
          },
          confirm: CONFIRM_PROPERTY,
        },
        required: ["x1", "y1", "x2", "y2"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args) => {
        assertKnownKeys(args, ["x1", "y1", "x2", "y2", "duration_ms", "confirm"]);
        const from = { x: coordinateArg(args, "x1"), y: coordinateArg(args, "y1") };
        const to = { x: coordinateArg(args, "x2"), y: coordinateArg(args, "y2") };
        const durationMs = integerArg(args, "duration_ms", { min: 50, max: 5000, fallback: 300 });
        gateConfirmation(cfg, "phone_swipe", args);
        const screen = await phone.tryScreenSize();
        assertWithinScreen(from, screen, "swipe start point");
        assertWithinScreen(to, screen, "swipe end point");
        const result = await phone.swipe({
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          durationMs,
        });
        return textResult(
          `Swiped (${from.x}, ${from.y}) -> (${to.x}, ${to.y}) over ${durationMs} ms via ${result.via}. ${AFTER_ACTION}`,
        );
      },
    },
    {
      name: "phone_press_key",
      title: "Press a hardware key",
      description:
        "Press a hardware or navigation key: HOME, BACK, APP_SWITCH, ENTER, TAB, DEL, ESCAPE, DPAD_*, VOLUME_*, POWER, WAKEUP, SEARCH, MENU... An explicit KEYCODE_* name is accepted too. Enter requires confirmation because it submits and sends. " +
        AFTER_ACTION,
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: 40,
            description: "Key alias (HOME, BACK, ENTER, ...) or an explicit Android KEYCODE_* name.",
          },
          confirm: CONFIRM_PROPERTY,
        },
        required: ["key"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args) => {
        assertKnownKeys(args, ["key", "confirm"]);
        const raw = stringArg(args, "key", { required: true, minLength: 1, maxLength: 40 });
        const key = normalizeKey(raw);
        gateConfirmation(cfg, "phone_press_key", { ...args, key: key.name });
        const result = await phone.pressKey(key.argument);
        return textResult(`Pressed ${key.name} (${key.argument}) via ${result.via}. ${AFTER_ACTION}`);
      },
    },
    {
      name: "phone_launch_app",
      title: "Launch an app",
      description:
        "Bring an installed app to the foreground by its package name (for example com.whatsapp). Does not type, tap or send anything by itself. " +
        AFTER_ACTION,
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            maxLength: 200,
            description: "Application package name, like com.android.settings.",
          },
          confirm: CONFIRM_PROPERTY,
        },
        required: ["package"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args) => {
        assertKnownKeys(args, ["package", "confirm"]);
        const packageName = validatePackageName(args.package);
        gateConfirmation(cfg, "phone_launch_app", args);
        const result = await phone.launchApp(packageName);
        const component = result.component ? ` (${result.component})` : "";
        return textResult(`Launched ${packageName}${component} via ${result.via}. ${AFTER_ACTION}`);
      },
    },
    {
      name: "phone_type_text",
      title: "Type text into the focused field",
      description:
        "Type into whatever field currently has keyboard focus. Printable ASCII only: adb's input text cannot type other characters, so tap the on-screen keyboard for those. Always requires confirmation, because typing is how messages are sent and purchases are approved. " +
        AFTER_ACTION,
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Printable ASCII text to type. Use phone_press_key ENTER to send it.",
          },
          confirm: {
            type: "boolean",
            description:
              "Must be true. Set it only after the user confirmed that this text may be typed (messages, credentials and payments all go through here).",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args) => {
        assertKnownKeys(args, ["text", "confirm"]);
        const text = validateText(args.text, { maxLength: cfg.maxTextLength });
        gateConfirmation(cfg, "phone_type_text", args);
        const result = await phone.typeText(text);
        const preview = JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
        return textResult(`Typed ${text.length} character(s) via ${result.via}: ${preview}. ${AFTER_ACTION}`);
      },
    },
  ];

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    names: TOOL_NAMES.slice(),
    list() {
      return definitions.map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      }));
    },
    get(name) {
      return byName.get(name) ?? null;
    },
  };
}
