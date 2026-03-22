#!/usr/bin/env node

/**
 * SessionStart hook: clears docs-guard state ONLY on fresh sessions.
 * Resume/compact/clear should NOT wipe lookups — the user already did the work.
 *
 * @see {@link https://code.claude.com/docs/en/hooks} for hook I/O contract
 */

const { clearState, getStatePath, dumpState } = require("./state");
const { createLogger, setContext } = require("../../lib/logger");
const log = createLogger("docs-guard");

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  try {
    const hookInput = JSON.parse(raw);
    setContext({ session_id: hookInput.session_id, hook_event_name: hookInput.hook_event_name });
    const source = hookInput.source || "unknown";
    const currentState = dumpState();
    const lookupCount = currentState.lookups?.length || 0;
    const mappingCount = currentState.mappings?.length || 0;

    log.info("SessionStart", { source, lookups: lookupCount, mappings: mappingCount, statePath: getStatePath() });

    if (source === "startup") {
      log.info("Fresh session — clearing state", { lookups: lookupCount, mappings: mappingCount });
      clearState();
    } else {
      log.debug("Preserving state", { source, lookups: lookupCount, mappings: mappingCount });
    }

    process.exit(0);
  } catch (e) {
    log.error("Session clear failed", { error: e.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
