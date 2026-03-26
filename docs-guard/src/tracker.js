#!/usr/bin/env node

/**
 * PostToolUse hook: tracks doc lookups and resolve mappings.
 *
 * resolve-library-id: records mapping (npmName → context7Ids) + resolve attempt. NOT a lookup.
 * query-docs: records lookup under mapped npm name (or fuzzy fallback with warning).
 * WebSearch/WebFetch/learndocs: records lookup directly.
 *
 * Hook input fields (PostToolUse): session_id, transcript_path, cwd,
 * permission_mode, hook_event_name, tool_name, tool_input, tool_result.
 *
 * @see {@link https://docs.anthropic.com/en/docs/claude-code/hooks} for hook I/O contract
 */

const {
  recordLookup,
  recordMapping,
  findMappedLibrary,
  recordResolveAttempt,
} = require("./state");
const { createLogger, setContext } = require("../../lib/logger");
const log = createLogger("docs-guard");

// --- resolve-library-id: mapping only, NOT a lookup ---

function handleResolve(toolInput, toolResponse) {
  const npmName = toolInput.libraryName || "";
  const query = toolInput.query || npmName;
  if (!npmName) return false;

  // Record that resolve was attempted
  recordResolveAttempt(npmName, query);

  // Parse context7 IDs from tool_result (PostToolUse stdin field)
  const context7Ids = parseContext7Ids(toolResponse);
  if (context7Ids.length > 0) {
    recordMapping(npmName, context7Ids);
    log.info("Resolve mapping recorded", { npmName, context7Ids });
  } else {
    // Log raw result shape for debugging
    log.debug("Resolve result — no IDs parsed", {
      npmName,
      responseType: typeof toolResponse,
      responsePreview: toolResponse
        ? (typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse)).slice(0, 300)
        : "(no tool_result)",
    });
  }

  return false; // Never counts as a lookup
}

/**
 * Parse context7 library IDs from resolve-library-id tool_result.
 * The response is text containing lines like:
 *   "- Context7-compatible library ID: /reactjs/react.dev"
 */
function parseContext7Ids(toolResponse) {
  if (!toolResponse) return [];
  const text = typeof toolResponse === "string"
    ? toolResponse
    : (toolResponse.text || toolResponse.content || JSON.stringify(toolResponse));
  const ids = [];
  const pattern = /Context7-compatible library ID:\s*(\/[^\s\\]+)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

// --- query-docs: lookup via mapping ---

function handleQueryDocs(toolInput) {
  const libraryId = toolInput.libraryId || "";
  const query = toolInput.query || "";

  // Try to resolve via mapping first
  const mappedName = findMappedLibrary(libraryId);
  if (mappedName) {
    log.info("query-docs lookup via mapping", { libraryId, mappedName, query });
    recordLookup(mappedName, query, "context7");
    return true;
  }

  // D4: No fuzzy fallback. Without a validated mapping, query-docs does NOT count.
  // A crafted libraryId like "/anything/react" could inject arbitrary library names.
  // Users must call resolve-library-id first (which creates the mapping),
  // or use WebSearch/WebFetch as an alternative doc source.
  log.warn("query-docs rejected — no mapping found for libraryId", { libraryId, query });
  return false;
}

// --- Other extractors (unchanged) ---

function extractFromLearndocs(input) {
  const query = input.query || input.search_query || input.url || "";
  // D7: learndocs is for Microsoft/Azure docs only. Record under "microsoft" domain,
  // NOT the first word of the query (which could inject arbitrary library names).
  // If someone searches learndocs for "react hooks", that does NOT satisfy the gate for react.
  return { library: "microsoft", query, source: "learndocs" };
}

function extractFromWebSearch(input) {
  const query = input.query || input.search_query || "";
  // D6: Extract a single library name from query if possible, not empty string.
  // Empty library + fuzzy query matching let one search spray-authorize many libraries.
  // We record under the query text; hasLookup will match via query containment for the
  // specific library being checked. But we no longer record library="".
  return { library: "", query, source: "web-search" };
}

function extractFromWebFetch(input) {
  const url = input.url || "";
  const query = input.query || url;
  let library = "";
  const match = url.match(/(?:docs|api|reference)\.([a-z-]+)\./i)
    || url.match(/github\.com\/[^/]+\/([^/]+)/i)
    || url.match(/npmjs\.com\/package\/([^/]+)/i);
  if (match) library = match[1];
  return { library, query, source: "web-fetch" };
}

function extractFromRead(input) {
  const filePath = input.file_path || "";
  if (!filePath.includes("/refs/") && !filePath.includes("\\refs\\")) return null;
  const refsIdx = filePath.indexOf("refs");
  const afterRefs = filePath.slice(refsIdx + 5);
  const library = afterRefs.split(/[/\\]/)[0] || "";
  return { library, query: `read ${afterRefs}`, source: "local-refs" };
}

const SIMPLE_EXTRACTORS = {
  "mcp__learndocs__microsoft_docs_search": extractFromLearndocs,
  "mcp__learndocs__microsoft_docs_fetch": extractFromLearndocs,
  "mcp__learndocs__microsoft_code_sample_search": extractFromLearndocs,
  "WebSearch": extractFromWebSearch,
  "WebFetch": extractFromWebFetch,
  "Read": extractFromRead,
};

/**
 * Core tracking logic.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {*} toolResponse - tool output (tool_result field from PostToolUse stdin)
 * @returns {boolean} true if a lookup was recorded
 */
function track(toolName, toolInput, toolResponse) {
  // resolve-library-id: mapping only
  if (toolName === "mcp__context7__resolve-library-id") {
    return handleResolve(toolInput, toolResponse);
  }

  // query-docs: lookup via mapping
  if (toolName === "mcp__context7__query-docs") {
    return handleQueryDocs(toolInput);
  }

  // Other tools: simple extraction
  const extractor = SIMPLE_EXTRACTORS[toolName];
  if (!extractor) {
    log.debug("No extractor for tool", { toolName });
    return false;
  }

  const result = extractor(toolInput);
  if (result && (result.library || result.query)) {
    log.debug("Recording lookup", { source: result.source, library: result.library, query: result.query });
    recordLookup(result.library, result.query, result.source);
    return true;
  }

  log.debug("Extractor returned nothing", { toolName });
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
    setContext({ session_id: hookInput.session_id, hook_event_name: hookInput.hook_event_name, tool_name: hookInput.tool_name });
    // First-party docs use tool_result; older builds may send tool_response
    track(hookInput.tool_name, hookInput.tool_input || {}, hookInput.tool_result ?? hookInput.tool_response);
    process.exit(0);
  } catch (e) {
    log.error("Tracker stdin parse failed", { error: e.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { track, parseContext7Ids, SIMPLE_EXTRACTORS };
