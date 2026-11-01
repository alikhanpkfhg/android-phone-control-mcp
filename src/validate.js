/**
 * Argument validation for the phone tools.
 *
 * Every tool gets a hand written schema in tools.js and, in addition, the
 * checks below: no unknown keys, integer coordinates inside hard limits,
 * screen bounds when the size is known, whitelisted key names, printable ASCII
 * text (that is what `adb shell input text` can type) and package names that
 * look like real application ids.
 */

export class ValidationError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** Android keycodes exposed by `phone_press_key` as friendly aliases. */
export const KEY_ALIASES = Object.freeze({
  HOME: "KEYCODE_HOME",
  BACK: "KEYCODE_BACK",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  RECENTS: "KEYCODE_APP_SWITCH",
  MENU: "KEYCODE_MENU",
  ENTER: "KEYCODE_ENTER",
  TAB: "KEYCODE_TAB",
  SPACE: "KEYCODE_SPACE",
  DEL: "KEYCODE_DEL",
  FORWARD_DEL: "KEYCODE_FORWARD_DEL",
  ESCAPE: "KEYCODE_ESCAPE",
  DPAD_UP: "KEYCODE_DPAD_UP",
  DPAD_DOWN: "KEYCODE_DPAD_DOWN",
  DPAD_LEFT: "KEYCODE_DPAD_LEFT",
  DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
  DPAD_CENTER: "KEYCODE_DPAD_CENTER",
  MOVE_HOME: "KEYCODE_MOVE_HOME",
  MOVE_END: "KEYCODE_MOVE_END",
  PAGE_UP: "KEYCODE_PAGE_UP",
  PAGE_DOWN: "KEYCODE_PAGE_DOWN",
  VOLUME_UP: "KEYCODE_VOLUME_UP",
  VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
  VOLUME_MUTE: "KEYCODE_VOLUME_MUTE",
  POWER: "KEYCODE_POWER",
  WAKEUP: "KEYCODE_WAKEUP",
  SLEEP: "KEYCODE_SLEEP",
  CAMERA: "KEYCODE_CAMERA",
  CALL: "KEYCODE_CALL",
  ENDCALL: "KEYCODE_ENDCALL",
  SEARCH: "KEYCODE_SEARCH",
  ASSIST: "KEYCODE_ASSIST",
  SETTINGS: "KEYCODE_SETTINGS",
  NOTIFICATIONS: "KEYCODE_NOTIFICATION",
  MEDIA_PLAY_PAUSE: "KEYCODE_MEDIA_PLAY_PAUSE",
  MEDIA_NEXT: "KEYCODE_MEDIA_NEXT",
  MEDIA_PREVIOUS: "KEYCODE_MEDIA_PREVIOUS",
  MEDIA_STOP: "KEYCODE_MEDIA_STOP",
});

/**
 * Hard upper limit for a coordinate. Real screens are far below this; the check
 * exists so that a typo (or a coordinate in the millions) is rejected instead of
 * being sent to the device.
 */
export const MAX_COORDINATE = 20000;

export const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function describe(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    const clipped = value.length > 40 ? `${value.slice(0, 40)}...` : value;
    return JSON.stringify(clipped);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value;
  }
}

export function assertKnownKeys(args, allowed) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new ValidationError("arguments must be a JSON object");
  }
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(
      `unknown argument(s) ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`,
    );
  }
}

function toNumber(value, field) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new ValidationError(`"${field}" must be a number (got ${describe(value)})`, { field });
}

export function integerArg(args, field, { min = -Infinity, max = Infinity, required = false, fallback } = {}) {
  const value = args?.[field];
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`"${field}" is required`, { field });
    return fallback;
  }
  const number = toNumber(value, field);
  if (!Number.isInteger(number)) {
    throw new ValidationError(`"${field}" must be a whole number (got ${describe(value)})`, {
      field,
    });
  }
  if (number < min || number > max) {
    throw new ValidationError(`"${field}" must be between ${min} and ${max} (got ${number})`, {
      field,
    });
  }
  return number;
}

export function coordinateArg(args, field) {
  return integerArg(args, field, { min: 0, max: MAX_COORDINATE, required: true });
}

export function stringArg(
  args,
  field,
  { minLength = 0, maxLength = Infinity, pattern, patternHint, required = false, fallback, trim = false } = {},
) {
  const raw = args?.[field];
  if (raw === undefined || raw === null) {
    if (required) throw new ValidationError(`"${field}" is required`, { field });
    return fallback;
  }
  if (typeof raw !== "string") {
    throw new ValidationError(`"${field}" must be a string (got ${describe(raw)})`, { field });
  }
  const value = trim ? raw.trim() : raw;
  if (value.length < minLength) {
    throw new ValidationError(`"${field}" must be at least ${minLength} character(s)`, { field });
  }
  if (value.length > maxLength) {
    throw new ValidationError(
      `"${field}" is too long (${value.length} > ${maxLength} characters)`,
      { field },
    );
  }
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(
      `"${field}" is not valid${patternHint ? `: ${patternHint}` : ""} (got ${describe(value)})`,
      { field },
    );
  }
  return value;
}

export function booleanArg(args, field, { fallback = false } = {}) {
  const value = args?.[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ValidationError(`"${field}" must be true or false (got ${describe(value)})`, { field });
}

/**
 * Turn a key alias (HOME, BACK, ENTER...) or an explicit KEYCODE_* name into the
 * argument passed to `adb shell input keyevent`.
 */
export function normalizeKey(raw) {
  if (typeof raw !== "string") {
    throw new ValidationError(`"key" must be a string (got ${describe(raw)})`, { field: "key" });
  }
  const value = raw.trim().toUpperCase();
  if (!value) throw new ValidationError('"key" must not be empty', { field: "key" });

  const alias = value.replace(/^KEYCODE_/, "");
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, alias)) {
    return { name: alias, argument: KEY_ALIASES[alias] };
  }
  if (/^KEYCODE_[A-Z0-9_]{1,40}$/.test(value)) {
    return { name: alias, argument: value };
  }
  throw new ValidationError(
    `unknown key "${raw}" (known: ${Object.keys(KEY_ALIASES).join(", ")}; or an explicit KEYCODE_*)`,
    { field: "key" },
  );
}

export function validateText(raw, { maxLength = 4000 } = {}) {
  if (raw === undefined || raw === null) {
    throw new ValidationError('"text" is required', { field: "text" });
  }
  if (typeof raw !== "string") {
    throw new ValidationError(`"text" must be a string (got ${describe(raw)})`, { field: "text" });
  }
  if (raw.length < 1) throw new ValidationError('"text" must not be empty', { field: "text" });
  if (raw.length > maxLength) {
    throw new ValidationError(
      `"text" is too long (${raw.length} > ${maxLength} characters)`,
      { field: "text" },
    );
  }
  if (/[\r\n\t]/.test(raw)) {
    throw new ValidationError(
      '"text" must not contain line breaks or tabs; send them with phone_press_key (Enter/Tab) instead',
      { field: "text" },
    );
  }
  if (/[^\x20-\x7E]/.test(raw)) {
    throw new ValidationError(
      '"text" must be printable ASCII: adb\'s `input text` cannot type other characters (use phone_tap on the on-screen keyboard for those)',
      { field: "text" },
    );
  }
  return raw;
}

export function validatePackageName(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ValidationError(`"package" must look like com.example.app (got ${describe(raw)})`, {
      field: "package",
    });
  }
  const value = raw.trim();
  if (!PACKAGE_NAME_PATTERN.test(value)) {
    throw new ValidationError(`"package" must look like com.example.app (got ${describe(raw)})`, {
      field: "package",
    });
  }
  return value;
}

/**
 * Reject coordinates outside the screen when its size is known.
 */
export function assertWithinScreen(point, screen, label = "coordinate") {
  if (!screen || !Number.isFinite(screen.width) || !Number.isFinite(screen.height)) return;
  if (point.x > screen.width - 1 || point.y > screen.height - 1) {
    throw new ValidationError(
      `${label} (${point.x}, ${point.y}) is outside the ${screen.width}x${screen.height} screen`,
    );
  }
}
