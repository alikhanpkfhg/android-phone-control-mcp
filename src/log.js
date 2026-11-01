import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function format(level, message, fields) {
  const stamp = new Date().toISOString();
  const head = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) return head;
  let tail;
  try {
    tail = JSON.stringify(fields);
  } catch {
    tail = "[unserialisable fields]";
  }
  return `${head} ${tail}`;
}

/**
 * Tiny logger that writes to stderr and, when a file is configured, appends to
 * that file. Logging never throws: a broken log file must not stop the server.
 */
export function createLogger({ file = null, level = "info", silent = false } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  let logFile = file;

  function write(levelName, message, fields) {
    const importance = LEVELS[levelName] ?? LEVELS.info;
    if (importance < threshold) return;
    const line = format(levelName, message, fields);
    if (!silent) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* ignore */
      }
    }
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      /* ignore */
    }
  }

  return {
    level: level,
    setFile(nextFile) {
      logFile = nextFile;
    },
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
