"use strict";

/**
 * Shared hook output formatting for all PreToolUse deny responses.
 *
 * Single source of truth for the deny JSON shape.
 * permissionDecisionReason = short reason (CLI displays this)
 * systemMessage = guidance for Claude (different wording to avoid duplicate rendering)
 */

function denyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\n";
}

module.exports = { denyOutput };
