#!/usr/bin/env node

/**
 * SessionStart hook: clears stale docs-guard state from previous sessions.
 *
 * Hook contract:
 *   stdin:  { session_id, hook_event_name: "SessionStart", source, ... }
 *   exit 0: success
 *
 * @see {@link https://code.claude.com/docs/en/hooks} for hook I/O contract
 */

const { clearState, getStatePath } = require("./state");
const { debug, error: logError } = require("./debug");

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  try {
    const hookInput = JSON.parse(raw);
    const source = hookInput.source || "unknown";
    debug(`SessionStart (${source}): clearing docs-guard state at ${getStatePath()}`);
    clearState();
    process.exit(0);
  } catch (e) {
    logError(`Session clear failed:`, e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
