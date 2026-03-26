#!/usr/bin/env node

/**
 * SessionStart hook: clears docs-guard state ONLY on fresh sessions.
 * Resume/compact/clear should NOT wipe lookups — the user already did the work.
 *
 * The `source` field is not in the first-party hook docs but is observed in practice.
 * Known values: "startup" (fresh session). If the field is missing or unrecognized,
 * we default to clearing state (fail-safe: stale state is worse than re-doing lookups).
 *
 * @see {@link https://docs.anthropic.com/en/docs/claude-code/hooks} for hook I/O contract
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
    const source = hookInput.source || "";
    const currentState = dumpState();
    const lookupCount = currentState.lookups?.length || 0;
    const mappingCount = currentState.mappings?.length || 0;

    log.info("SessionStart", { source: source || "(not provided)", lookups: lookupCount, mappings: mappingCount, statePath: getStatePath() });

    // Preserve state only for known resume-like sources; clear for everything else
    // (including fresh starts and unknown/missing source values)
    const PRESERVE_SOURCES = new Set(["resume", "compact", "clear"]);
    if (PRESERVE_SOURCES.has(source)) {
      log.debug("Preserving state", { source, lookups: lookupCount, mappings: mappingCount });
    } else {
      log.info("Clearing state", { source: source || "startup/unknown", lookups: lookupCount, mappings: mappingCount });
      clearState();
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
