"use strict";

/**
 * Backward-compat shim: re-exports from shared lib/logger.js.
 * Existing docs-guard code that requires("./debug") continues working.
 */

const { createLogger, logFilePath } = require("../../lib/logger");
const log = createLogger("docs-guard");

module.exports = {
  debug: log.debug,
  warn: log.warn,
  error: log.error,
  logFilePath,
};
