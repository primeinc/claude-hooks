/**
 * Debug logging for docs-guard.
 *
 * Stderr: always available, doesn't pollute hook stdout (which must be JSON).
 * File:   optional, rotated by size, for post-mortem analysis.
 *
 * Env vars:
 *   DOCS_GUARD_DEBUG=1          — enable debug-level output to stderr
 *   DOCS_GUARD_LOG=<path>       — also append all levels to a file
 *   DOCS_GUARD_LOG_MAX_KB=512   — max log file size before rotation (default 512KB)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const crypto = require("crypto");

const debugEnabled = process.env.DOCS_GUARD_DEBUG === "1";
// Per-session log file keyed by CWD — same hash as state file.
// Multiple sessions get separate logs instead of stomping each other.
const cwd = process.env.CLAUDE_CWD || process.cwd();
const cwdHash = crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
const logFilePath = process.env.DOCS_GUARD_LOG
  || path.join(os.tmpdir(), `docs-guard-${cwdHash}.log`);
// Always log to file. You can't debug a hook that doesn't leave a trace.
const logToFile = true;
const maxLogBytes = (parseInt(process.env.DOCS_GUARD_LOG_MAX_KB, 10) || 512) * 1024;

/**
 * Rotate log file if it exceeds maxLogBytes.
 * Keeps one .prev backup.
 */
function rotateIfNeeded() {
  if (!logToFile) return;
  try {
    const stat = fs.statSync(logFilePath);
    if (stat.size > maxLogBytes) {
      const prev = logFilePath + ".prev";
      try { fs.unlinkSync(prev); } catch { /* noop */ }
      fs.renameSync(logFilePath, prev);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Can't stat the file for some other reason — don't crash
      // Can't use main log — write to emergency fallback instead
      try { fs.appendFileSync(logFilePath + ".errors", `${new Date().toISOString()} Log rotation failed: ${e.message}\n`); } catch {}
    }
  }
}

/**
 * Format a log line.
 */
function formatLine(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  return `${ts} [${level}] ${msg}\n`;
}

/**
 * Write to log file (append, non-blocking best-effort).
 */
function appendToFile(line) {
  if (!logToFile) return;
  try {
    fs.appendFileSync(logFilePath, line);
  } catch (e) {
    try { fs.appendFileSync(logFilePath + ".errors", `${new Date().toISOString()} Log write failed: ${e.message}\n`); } catch {}
  }
}

function debug(...args) {
  const line = formatLine("DEBUG", args);
  if (debugEnabled) console.error(line.trimEnd());
  if (logToFile) appendToFile(line);
}

function warn(...args) {
  const line = formatLine("WARN", args);
  if (debugEnabled) console.error(line.trimEnd());
  if (logToFile) appendToFile(line);
}

function error(...args) {
  const line = formatLine("ERROR", args);
  if (debugEnabled) console.error(line.trimEnd());
  if (logToFile) appendToFile(line);
}

// Rotate on module load (once per process)
rotateIfNeeded();

module.exports = { debug, warn, error, logFilePath };
