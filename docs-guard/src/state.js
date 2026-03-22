/**
 * Session state management for docs-guard.
 *
 * State model:
 *   lookups:          completed doc reads (query-docs, WebSearch, etc.)
 *   mappings:         npm name → context7 library IDs (from resolve-library-id)
 *   resolveAttempts:  records that resolve-library-id was called (tracks intent)
 *   providerFailures: records incomplete lookup flows (resolve happened, query-docs didn't)
 *
 * State persists across the session in a temp file keyed by working directory.
 *
 * @see {@link https://nodejs.org/api/os.html#ostmpdir} for temp directory
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createLogger } = require("../../lib/logger");
const log = createLogger("docs-guard");

function getStatePath() {
  const cwd = process.env.CLAUDE_CWD || process.cwd();
  const hash = crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `docs-guard-${hash}.json`);
}

const EMPTY_STATE = { lookups: [], mappings: [], resolveAttempts: [], providerFailures: [] };

function readState() {
  const statePath = getStatePath();
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const state = JSON.parse(raw);
    // Migrate old format
    if (!state.mappings) state.mappings = [];
    if (!state.resolveAttempts) state.resolveAttempts = [];
    if (!state.providerFailures) state.providerFailures = [];
    if (!state.lookups) state.lookups = [];
    return state;
  } catch (e) {
    if (e.code !== "ENOENT") {
      log.warn("Failed to read state", { path: statePath, error: e.message });
    }
    return { ...EMPTY_STATE };
  }
}

function writeState(state) {
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

// --- Lookups (completed doc reads) ---

function recordLookup(library, query, source) {
  const state = readState();
  state.lookups.push({
    library: library.toLowerCase(),
    query: (query || "").toLowerCase(),
    source,
    ts: Date.now(),
  });
  writeState(state);
}

// --- Mappings (npm name → context7 IDs) ---

function recordMapping(npmName, context7Ids) {
  const state = readState();
  const existing = state.mappings.find(m => m.npmName === npmName.toLowerCase());
  if (existing) {
    // Merge new IDs
    for (const id of context7Ids) {
      if (!existing.context7Ids.includes(id)) existing.context7Ids.push(id);
    }
    existing.ts = Date.now();
  } else {
    state.mappings.push({
      npmName: npmName.toLowerCase(),
      context7Ids,
      ts: Date.now(),
    });
  }
  log.debug("Recorded mapping", { npmName, context7Ids });
  writeState(state);
}

function findMappedLibrary(libraryId) {
  const state = readState();
  const id = libraryId.toLowerCase();
  for (const mapping of state.mappings) {
    if (mapping.context7Ids.some(cid => cid.toLowerCase() === id)) {
      return mapping.npmName;
    }
  }
  return null;
}

// --- Resolve attempts (intent tracking) ---

function recordResolveAttempt(npmName, query) {
  const state = readState();
  state.resolveAttempts.push({
    npmName: npmName.toLowerCase(),
    query: (query || "").toLowerCase(),
    ts: Date.now(),
  });
  log.debug("Recorded resolve attempt", { npmName });
  writeState(state);
}

// --- Provider failures (incomplete flows) ---

function recordProviderFailure(npmName, stage, reason) {
  const state = readState();
  state.providerFailures.push({
    npmName: npmName.toLowerCase(),
    stage,
    reason,
    ts: Date.now(),
  });
  log.warn("Provider failure", { npmName, stage, reason });
  writeState(state);
}

// --- Lookup checking ---

/**
 * Generate all name variants for matching scoped packages.
 * "@vitejs/plugin-react" → ["@vitejs/plugin-react", "vitejs/plugin-react", "vitejs-plugin-react", "plugin-react"]
 */
function nameVariants(name) {
  const variants = [name];
  if (name.startsWith("@")) {
    const stripped = name.slice(1);
    variants.push(stripped);
    variants.push(stripped.replace("/", "-"));
    const afterSlash = stripped.split("/")[1];
    if (afterSlash) variants.push(afterSlash);
  }
  return variants;
}

/**
 * Check if a library has been looked up.
 *
 * Strategy (in order):
 *   1. Exact mapped match: mapping exists AND a lookup was recorded for that npm name
 *   2. Fuzzy match: substring containment with name variants (with logged warning)
 *   3. Check if resolve was attempted but query-docs never completed (degraded mode)
 *
 * @param {string} library - npm package name
 * @returns {{ found: boolean, lookups: Array, method?: string, degraded?: boolean, resolveAttempted?: boolean }}
 */
function hasLookup(library) {
  const state = readState();
  const lib = library.toLowerCase();

  // 1. Exact match on lookup library field
  const exactMatches = state.lookups.filter(l => l.library === lib);
  if (exactMatches.length > 0) {
    return { found: true, lookups: exactMatches, method: "exact" };
  }

  // 2. Mapped match: did a mapping resolve this npm name, and was a lookup recorded under it?
  const mapping = state.mappings.find(m => m.npmName === lib);
  if (mapping) {
    // Check if any lookup was recorded that could be for this mapping's context7 IDs
    const mappedLookups = state.lookups.filter(l => {
      // The lookup library might be the context7 ID segment
      for (const cid of mapping.context7Ids) {
        const segments = cid.split("/").filter(Boolean).filter(s => !/^v?\d/.test(s));
        if (segments.some(seg => seg.toLowerCase() === l.library)) return true;
      }
      return false;
    });
    if (mappedLookups.length > 0) {
      return { found: true, lookups: mappedLookups, method: "mapped" };
    }
  }

  // 3. Fuzzy match with name variants (demoted — log warning when used)
  const libVariants = nameVariants(lib);
  const fuzzyMatches = state.lookups.filter(l => {
    const lookupVariants = nameVariants(l.library);
    for (const nv of libVariants) {
      if (nv.length <= 1) continue;
      for (const lv of lookupVariants) {
        if (lv.length <= 1) continue;
        if (nv === lv) return true;
        if (nv.includes(lv)) return true;
        if (lv.includes(nv)) return true;
      }
      if (l.query.includes(nv)) return true;
    }
    return false;
  });
  if (fuzzyMatches.length > 0) {
    log.warn("Fuzzy match used (no deterministic mapping)", { library: lib, matchedVia: fuzzyMatches[0].library });
    return { found: true, lookups: fuzzyMatches, method: "fuzzy" };
  }

  // 4. Check for degraded mode: resolve was attempted but query-docs never completed
  const resolveAttempt = state.resolveAttempts.find(r => r.npmName === lib);
  if (resolveAttempt) {
    // Also check if WebSearch/WebFetch covered this library as fallback
    const webFallback = state.lookups.filter(l =>
      (l.source === "web-search" || l.source === "web-fetch") &&
      libVariants.some(v => v.length > 1 && l.query.includes(v))
    );
    if (webFallback.length > 0) {
      return { found: true, lookups: webFallback, method: "web-fallback" };
    }
    return { found: false, lookups: [], degraded: true, resolveAttempted: true };
  }

  return { found: false, lookups: [] };
}

function hasFeatureLookup(library, feature) {
  const result = hasLookup(library);
  if (!result.found) return result;
  const normalizedFeature = feature.toLowerCase().split(".").pop();
  const featureMatches = result.lookups.filter(l => l.query.includes(normalizedFeature));
  return { found: true, lookups: featureMatches.length > 0 ? featureMatches : result.lookups, method: result.method };
}

function clearState() {
  const statePath = getStatePath();
  try {
    fs.unlinkSync(statePath);
  } catch (e) {
    if (e.code !== "ENOENT") {
      log.warn("Failed to clear state", { path: statePath, error: e.message });
    }
  }
}

function dumpState() {
  return readState();
}

module.exports = {
  getStatePath,
  readState,
  recordLookup,
  recordMapping,
  findMappedLibrary,
  recordResolveAttempt,
  recordProviderFailure,
  hasLookup,
  hasFeatureLookup,
  clearState,
  dumpState,
};
