"use strict";

/**
 * Shared structured JSON logger for all claude-hooks subsystems.
 *
 * Usage:
 *   const { createLogger, setContext } = require("../../lib/logger");
 *   const log = createLogger("docs-guard");
 *   // after stdin parse:
 *   setContext({ session_id, hook_event_name, tool_name, cwd });
 *   log.debug("Gate check", { file: "app.ts" });
 *
 * Log line schema:
 *   {"ts":"...","level":"debug","sub":"docs-guard","sid":"abc","event":"PreToolUse","tool":"Write","msg":"...","data":{}}
 *
 * File: {tmpdir}/claude-hooks-{cwdHash}.log (one per project, all subsystems)
 * Rotation: 512KB default, keeps .prev
 * stderr: warn/error always, debug/info only if CLAUDE_HOOKS_DEBUG=1
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// --- CWD hash (shared identity with state.js) ---
const cwd = process.env.CLAUDE_CWD || process.cwd();
const cwdHash = crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);

// --- Config ---
const debugToStderr = process.env.CLAUDE_HOOKS_DEBUG === "1";
const logFilePath = process.env.CLAUDE_HOOKS_LOG
  || path.join(os.tmpdir(), `claude-hooks-${cwdHash}.log`);
const maxLogBytes = (parseInt(process.env.CLAUDE_HOOKS_LOG_MAX_KB, 10) || 512) * 1024;

// --- Rotation ---
function rotateIfNeeded() {
  try {
    const stat = fs.statSync(logFilePath);
    if (stat.size > maxLogBytes) {
      const prev = logFilePath + ".prev";
      try { fs.unlinkSync(prev); } catch { /* noop */ }
      fs.renameSync(logFilePath, prev);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`[claude-hooks] Log rotation failed: ${e.message}`);
    }
  }
}
rotateIfNeeded();

// --- Correlation context (set once per process after stdin parse) ---
let ctx = {
  session_id: "",
  hook_event_name: "",
  tool_name: "",
};

function setContext(fields) {
  if (fields.session_id) ctx.session_id = fields.session_id;
  if (fields.hook_event_name) ctx.hook_event_name = fields.hook_event_name;
  if (fields.tool_name) ctx.tool_name = fields.tool_name;
}

// --- Write ---
function writeLine(level, subsystem, msg, data) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    sub: subsystem,
    sid: ctx.session_id,
    event: ctx.hook_event_name,
    tool: ctx.tool_name,
    msg,
    ...(data !== undefined ? { data } : {}),
  }) + "\n";

  // File: always
  try {
    fs.appendFileSync(logFilePath, line);
  } catch (e) {
    console.error(`[claude-hooks] Log write failed: ${e.message}`);
  }

  // stderr is reserved for hook contract messages (exit 2 block reasons).
  // Logger output goes to file only to avoid corrupting hook responses.
  // Use CLAUDE_HOOKS_DEBUG=1 to also see log lines on stderr (for manual debugging only).
  if (debugToStderr) {
    process.stderr.write(line);
  }
}

// --- Factory ---
function createLogger(subsystem) {
  return {
    debug: (msg, data) => writeLine("debug", subsystem, msg, data),
    info: (msg, data) => writeLine("info", subsystem, msg, data),
    warn: (msg, data) => writeLine("warn", subsystem, msg, data),
    error: (msg, data) => writeLine("error", subsystem, msg, data),
    logFilePath,
  };
}

module.exports = { createLogger, setContext, logFilePath, cwdHash };
