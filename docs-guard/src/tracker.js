#!/usr/bin/env node

/**
 * PostToolUse hook: tracks doc lookups from context7, learndocs, WebSearch, WebFetch.
 *
 * Hook contract:
 *   stdin:  { session_id, hook_event_name, tool_name, tool_input, ... }
 *   exit 0: success, tracking recorded (PostToolUse cannot block)
 *   exit 1: non-blocking error, stderr shown in verbose mode
 *
 * @see {@link https://code.claude.com/docs/en/hooks} for hook I/O contract
 */

const { recordLookup } = require("./state");
const { debug, error: logError } = require("./debug");

function extractFromContext7Resolve(input) {
  return {
    library: input.libraryName || "",
    query: input.query || input.libraryName || "",
    source: "context7",
  };
}

function extractFromContext7Query(input) {
  // libraryId formats from real sessions:
  //   /colinhacks/zod           → "zod"
  //   /expressjs/express/v5.1.0 → "express" (NOT "v5.1.0")
  //   /llmstxt/valibot_dev_llms-full_txt → "valibot_dev_llms-full_txt"
  //   /websites/react_dev       → "react_dev"
  //
  // Strategy: use all non-version segments joined, so hasLookup's
  // reverse containment can match against any of them.
  const libraryId = input.libraryId || "";
  const segments = libraryId.split("/").filter(Boolean);
  // Drop version-like segments (start with v + digit, or pure semver)
  const meaningful = segments.filter(s => !/^v?\d/.test(s));
  // Use the last meaningful segment, fallback to last segment, fallback to full ID
  const library = meaningful.pop() || segments.pop() || libraryId;
  return {
    library,
    query: input.query || "",
    source: "context7",
  };
}

function extractFromLearndocs(input) {
  const query = input.query || input.search_query || input.url || "";
  const library = query.split(" ")[0] || "microsoft";
  return {
    library,
    query,
    source: "learndocs",
  };
}

function extractFromWebSearch(input) {
  const query = input.query || input.search_query || "";
  return {
    library: "",
    query,
    source: "web-search",
  };
}

function extractFromWebFetch(input) {
  const url = input.url || "";
  const query = input.query || url;
  let library = "";
  const match = url.match(/(?:docs|api|reference)\.([a-z-]+)\./i)
    || url.match(/github\.com\/[^/]+\/([^/]+)/i)
    || url.match(/npmjs\.com\/package\/([^/]+)/i);
  if (match) library = match[1];
  return {
    library,
    query,
    source: "web-fetch",
  };
}

function extractFromRead(input) {
  const filePath = input.file_path || "";
  if (!filePath.includes("/refs/") && !filePath.includes("\\refs\\")) {
    return null;
  }
  const refsIdx = filePath.indexOf("refs");
  const afterRefs = filePath.slice(refsIdx + 5);
  const library = afterRefs.split(/[/\\]/)[0] || "";
  return {
    library,
    query: `read ${afterRefs}`,
    source: "local-refs",
  };
}

const EXTRACTORS = {
  // NOTE: resolve-library-id is intentionally excluded.
  // It only resolves a name to an ID — no docs are read.
  // Claude will game the gate by spamming resolve without ever calling query-docs.
  // Only query-docs (actual doc retrieval) counts as a lookup.
  "mcp__context7__query-docs": extractFromContext7Query,
  "mcp__learndocs__microsoft_docs_search": extractFromLearndocs,
  "mcp__learndocs__microsoft_docs_fetch": extractFromLearndocs,
  "mcp__learndocs__microsoft_code_sample_search": extractFromLearndocs,
  "WebSearch": extractFromWebSearch,
  "WebFetch": extractFromWebFetch,
  "Read": extractFromRead,
};

/**
 * Core tracking logic — importable by tests and replay scripts.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {boolean} true if a lookup was recorded
 */
function track(toolName, toolInput) {
  const extractor = EXTRACTORS[toolName];
  if (!extractor) {
    debug(`No extractor for tool: ${toolName}`);
    return false;
  }

  const result = extractor(toolInput);
  if (result && (result.library || result.query)) {
    debug(`Recording lookup: ${result.source} -> ${result.library} "${result.query}"`);
    recordLookup(result.library, result.query, result.source);
    return true;
  }

  debug(`Extractor returned nothing for ${toolName}`, toolInput);
  return false;
}

// --- stdin hook entrypoint ---

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  try {
    const hookInput = JSON.parse(raw);
    track(hookInput.tool_name, hookInput.tool_input || {});
    // PostToolUse: always exit 0, cannot block
    process.exit(0);
  } catch (e) {
    logError(`Tracker stdin parse failed:`, e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { track, EXTRACTORS };
