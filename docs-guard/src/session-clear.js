#!/usr/bin/env node

/**
 * SessionStart hook: clears docs-guard state ONLY on fresh sessions.
 * Resume/compact/clear should NOT wipe lookups — the user already did the work.
 *
 * @see {@link https://code.claude.com/docs/en/hooks} for hook I/O contract
 */

const { clearState, getStatePath, dumpState } = require("./state");
const { debug, error: logError } = require("./debug");

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  try {
    const hookInput = JSON.parse(raw);
    const source = hookInput.source || "unknown";
    const sessionId = hookInput.session_id || "unknown";
    const statePath = getStatePath();
    const currentState = dumpState();
    const lookupCount = currentState.lookups?.length || 0;

    debug(`SessionStart source="${source}" session="${sessionId}" statePath="${statePath}" existingLookups=${lookupCount}`);

    if (source === "startup") {
      debug(`Fresh session — clearing ${lookupCount} lookups`);
      clearState();
    } else {
      debug(`${source} — preserving ${lookupCount} lookups`);
    }

    process.exit(0);
  } catch (e) {
    logError(`Session clear failed:`, e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
