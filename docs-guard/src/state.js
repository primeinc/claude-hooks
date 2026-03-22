/**
 * Session state management for docs-guard.
 * Tracks which libraries/queries have been looked up via doc tools.
 * State persists across the session in a temp file keyed by working directory.
 *
 * @see {@link https://nodejs.org/api/os.html#ostmpdir} for temp directory
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { debug, warn } = require("./debug");

/**
 * Derive a stable state file path from the current working directory.
 * Different projects get different state files.
 */
function getStatePath() {
  const cwd = process.env.CLAUDE_CWD || process.cwd();
  const hash = crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `docs-guard-${hash}.json`);
}

/**
 * Read the current lookup state.
 * @returns {{ lookups: Array<{ library: string, query: string, source: string, ts: number }> }}
 */
function readState() {
  const statePath = getStatePath();
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT") {
      warn(`Failed to read state at ${statePath}: ${e.message}`);
    }
    return { lookups: [] };
  }
}

/**
 * Record a doc lookup.
 * @param {string} library - normalized library/package name
 * @param {string} query - the search query or topic
 * @param {string} source - which tool was used (context7, learndocs, web, etc.)
 */
function recordLookup(library, query, source) {
  const state = readState();
  state.lookups.push({
    library: library.toLowerCase(),
    query: (query || "").toLowerCase(),
    source,
    ts: Date.now(),
  });
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

/**
 * Check if a library has been looked up.
 *
 * Matching strategy (any match = found):
 *   1. Exact match: lookup library === npm name
 *   2. Query contains npm name: lookup query text mentions the package
 *   3. npm name contains lookup library: "@tanstack/react-query" contains "query"
 *   4. Lookup library contains npm name: "valibot_dev_llms-full_txt" contains "valibot"
 *      (This is the critical case — context7 library IDs embed the npm name
 *       in longer strings like "/llmstxt/valibot_dev_llms-full_txt")
 *
 * @param {string} library - npm package name to check
 * @returns {{ found: boolean, lookups: Array }}
 */
/**
 * Generate all name variants for matching.
 * Scoped packages like @vitejs/plugin-react need multiple forms:
 *   "@vitejs/plugin-react" → ["@vitejs/plugin-react", "vitejs/plugin-react", "vitejs-plugin-react", "plugin-react"]
 * Plain packages return as-is.
 */
function nameVariants(name) {
  const variants = [name];
  if (name.startsWith("@")) {
    const stripped = name.slice(1); // "vitejs/plugin-react"
    variants.push(stripped);
    variants.push(stripped.replace("/", "-")); // "vitejs-plugin-react"
    const afterSlash = stripped.split("/")[1]; // "plugin-react"
    if (afterSlash) variants.push(afterSlash);
  }
  return variants;
}

function hasLookup(library) {
  const state = readState();
  const lib = library.toLowerCase();
  const libVariants = nameVariants(lib);

  const matches = state.lookups.filter(l => {
    if (l.library === lib) return true;

    // Generate variants for both sides
    const lookupVariants = nameVariants(l.library);

    // Cross-check all npm variants against all lookup variants
    for (const nv of libVariants) {
      if (nv.length <= 1) continue;
      for (const lv of lookupVariants) {
        if (lv.length <= 1) continue;
        if (nv === lv) return true;
        if (nv.includes(lv)) return true;
        if (lv.includes(nv)) return true;
      }
      // Also check query text
      if (l.query.includes(nv)) return true;
    }
    return false;
  });
  return { found: matches.length > 0, lookups: matches };
}

/**
 * Check if a specific feature has been looked up.
 * @param {string} library - package name
 * @param {string} feature - specific API/feature name (e.g., "useOptimistic")
 * @returns {{ found: boolean, lookups: Array }}
 */
function hasFeatureLookup(library, feature) {
  const state = readState();
  const normalizedLib = library.toLowerCase();
  const normalizedFeature = feature.toLowerCase().split(".").pop();

  const matches = state.lookups.filter(l => {
    const libMatch = l.library === normalizedLib || l.query.includes(normalizedLib);
    if (!libMatch) return false;
    if (l.query.includes(normalizedFeature)) return true;
    return true;
  });

  return { found: matches.length > 0, lookups: matches };
}

/**
 * Clear all state (for session start cleanup).
 */
function clearState() {
  const statePath = getStatePath();
  try {
    fs.unlinkSync(statePath);
  } catch (e) {
    if (e.code !== "ENOENT") {
      warn(`Failed to clear state at ${statePath}: ${e.message}`);
    }
  }
}

/**
 * Dump state for debugging.
 */
function dumpState() {
  return readState();
}

module.exports = {
  getStatePath,
  readState,
  recordLookup,
  hasLookup,
  hasFeatureLookup,
  clearState,
  dumpState,
};
