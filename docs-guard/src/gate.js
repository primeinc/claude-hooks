#!/usr/bin/env node

/**
 * PreToolUse hook: blocks Write/Edit if the code uses third-party libraries
 * that haven't been looked up in docs first.
 *
 * Hook contract (PreToolUse JSON mode):
 *   stdin:  { session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id }
 *   allow:  exit 0 (no output needed)
 *   block:  exit 0 + JSON to stdout:
 *     { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "..." } }
 *
 * @see {@link https://code.claude.com/docs/en/hooks} for hook I/O contract
 */

const fs = require("fs");
const { extract } = require("./extract");
const { hasLookup } = require("./state");
const { createLogger, setContext } = require("../../lib/logger");
const log = createLogger("docs-guard");
const debug = log.debug;
const warn = log.warn;
const logError = log.error;

/**
 * Max lines to read from the top of a file to find imports.
 * Imports are conventionally at the top; 80 lines covers even messy files
 * with license headers, comments, and re-exports.
 */
const IMPORT_HEAD_LINES = 80;

/**
 * File extensions we can parse for imports.
 */
const PARSEABLE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
]);

/**
 * Check if a file path is parseable (JS/TS).
 */
function isParseable(filePath) {
  if (!filePath) return false;
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return PARSEABLE.has(ext);
}

/**
 * Read the top N lines from a file on disk to extract imports.
 * Returns null if file can't be read.
 */
function readFileHead(filePath, maxLines) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").slice(0, maxLines).join("\n");
  } catch (e) {
    if (e.code !== "ENOENT") {
      warn(`Failed to read file head ${filePath}: ${e.message}`);
    }
    return null;
  }
}

/**
 * Check an Edit by cross-referencing file imports with new_string usage.
 * Only flags libraries whose imported symbols actually appear in new_string.
 *
 * Strategy:
 *   1. Parse file head → get imports (library name + imported symbols)
 *   2. Text-search new_string for each imported symbol
 *   3. Only report libraries with symbols found in new_string
 *   4. Fallback: if file can't be read, parse new_string alone
 */
function checkEdit(toolInput, filePath) {
  const newString = toolInput.new_string || "";
  if (!newString) return { ok: true };

  const head = readFileHead(filePath, IMPORT_HEAD_LINES);

  if (!head) {
    // File doesn't exist — fall back to parsing new_string alone
    let result;
    try {
      result = extract(newString, filePath);
    } catch (e) {
      // D2: Fail-closed on parse failure — unparseable code cannot be verified
      warn(`AST parse failed for ${filePath}: ${e.message}`);
      return { ok: false, reason: "PARSE FAILURE: new_string could not be parsed for import detection. Fix syntax errors or look up any third-party libraries before writing." };
    }
    return checkLibraries(result.libraries);
  }

  // Parse file head to get import map
  let headResult;
  try {
    headResult = extract(head, filePath);
  } catch (e) {
    // D2: Fail-closed on parse failure — can't verify imports if head is unparseable
    warn(`AST parse of file head failed for ${filePath}: ${e.message}`);
    return { ok: false, reason: "PARSE FAILURE: File head could not be parsed for import detection. Fix syntax errors or look up any third-party libraries before editing." };
  }

  if (headResult.libraries.length === 0) {
    return { ok: true };
  }

  // For each library, check if ANY of its imported symbols appear in new_string
  const relevantLibs = [];
  for (const lib of headResult.libraries) {
    const symbolsInEdit = lib.imports.filter(sym => {
      // Clean namespace imports: "* as React" → "React"
      const cleanSym = sym.startsWith("* as ") ? sym.slice(5) : sym;
      // Word-boundary check: "useState" should match "useState(" but not "useStateManager"
      // Simple approach: check if the symbol appears as a standalone identifier
      const pattern = new RegExp(`\\b${escapeRegex(cleanSym)}\\b`);
      return pattern.test(newString);
    });

    if (symbolsInEdit.length > 0) {
      // Also extract specific features from new_string for this library
      const features = [];
      for (const sym of symbolsInEdit) {
        const cleanSym = sym.startsWith("* as ") ? sym.slice(5) : sym;
        // Find member accesses like "React.createElement", "z.object"
        const memberPattern = new RegExp(`\\b${escapeRegex(cleanSym)}\\.\\w+`, "g");
        const memberMatches = newString.match(memberPattern);
        if (memberMatches) {
          features.push(...memberMatches);
        }
        // Also add the bare symbol as a feature if it's called
        const callPattern = new RegExp(`\\b${escapeRegex(cleanSym)}\\s*\\(`);
        if (callPattern.test(newString)) {
          features.push(cleanSym);
        }
      }

      relevantLibs.push({
        name: lib.name,
        imports: symbolsInEdit,
        features: features.length > 0 ? features : symbolsInEdit,
      });
    }
  }

  if (relevantLibs.length === 0) {
    return { ok: true };
  }

  return checkLibraries(relevantLibs);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check a list of libraries against the lookup state.
 * Returns { ok, reason, uncovered } for the gate decision.
 */
function checkLibraries(libraries) {
  const uncovered = [];
  const degraded = [];

  for (const lib of libraries) {
    const lookup = hasLookup(lib.name);
    debug(`  hasLookup("${lib.name}"): ${lookup.found ? "FOUND via " + lookup.method : "NOT FOUND"} (${lookup.lookups.length} matches)`);

    if (lookup.found) {
      if (lookup.method) {
        debug(`    method: ${lookup.method}, matched: ${lookup.lookups.map(l => `${l.source}:"${l.library}"`).join(", ")}`);
      }
    } else if (lookup.degraded && lookup.resolveAttempted) {
      // Resolve happened but query-docs never completed — this is NOT "user skipped docs"
      debug(`  DEGRADED: resolve attempted for "${lib.name}" but query-docs never completed`);
      degraded.push({
        name: lib.name,
        features: lib.features,
      });
    } else {
      uncovered.push({
        name: lib.name,
        features: lib.features,
      });
    }
  }

  if (uncovered.length === 0 && degraded.length === 0) {
    debug("  All libraries covered — allowing");
    return { ok: true };
  }

  return { ok: false, uncovered, degraded };
}

/**
 * Core gate logic — importable by tests and replay scripts.
 *
 * @param {string} toolName - "Write" or "Edit"
 * @param {object} toolInput - { file_path, content } or { file_path, old_string, new_string }
 * @returns {{ ok: boolean, reason?: string, uncovered?: Array<{name: string, features: string[]}> }}
 */
/**
 * Tools the gate knows how to check. Unknown tools are blocked (fail-closed).
 */
const KNOWN_TOOLS = new Set(["Write", "Edit"]);

function check(toolName, toolInput) {
  // D13: Block unknown tools — fail-closed defense-in-depth
  if (!KNOWN_TOOLS.has(toolName)) {
    warn(`Unknown tool name routed to docs-guard: ${toolName}`);
    return { ok: false, reason: `GATE: Unknown tool "${toolName}" routed to docs-guard. Only Write and Edit are supported. Block as precaution. If you need to use ${toolName}, update the matcher in hooks/hooks.json to exclude it from the docs-guard hook.` };
  }

  const filePath = toolInput.file_path || "";
  const { readState } = require("./state");
  const currentState = readState();
  debug(`Gate check: ${toolName} on ${filePath} | ${currentState.lookups.length} lookups in state`);

  if (!isParseable(filePath)) {
    debug(`Skipping non-parseable file: ${filePath}`);
    return { ok: true };
  }

  // Edit: cross-reference file imports with new_string usage
  if (toolName === "Edit") {
    const editResult = checkEdit(toolInput, filePath);
    if (editResult.ok) return editResult;
    return formatBlock(toolName, filePath, editResult.uncovered || [], editResult.degraded || []);
  }

  // Write: check the full file content
  const code = toolInput.content || "";
  if (!code) {
    return { ok: true };
  }

  let result;
  try {
    result = extract(code, filePath);
  } catch (e) {
    // D2: Fail-closed on parse failure — unparseable code cannot be verified
    warn(`AST parse failed for ${filePath}: ${e.message}`);
    return { ok: false, reason: "PARSE FAILURE: Code could not be parsed for import detection. Fix syntax errors or look up any third-party libraries before writing." };
  }

  if (result.libraries.length === 0) {
    return { ok: true };
  }

  const libResult = checkLibraries(result.libraries);
  if (libResult.ok) return libResult;
  return formatBlock(toolName, filePath, libResult.uncovered || [], libResult.degraded || []);
}

/**
 * Format a block response with distinct messages for uncovered vs degraded.
 */
function formatBlock(toolName, filePath, uncovered, degraded) {
  const parts = [];

  if (uncovered.length > 0) {
    const libList = uncovered.map(u => {
      const feats = u.features.length > 0
        ? ` (using: ${u.features.slice(0, 5).join(", ")})`
        : "";
      return `  - ${u.name}${feats}`;
    }).join("\n");

    const suggestions = uncovered.map(u => {
      const topFeature = u.features[0] || u.name;
      return `  1. resolve-library-id(libraryName: "${u.name}", query: "${topFeature}")` +
        `\n  2. query-docs(libraryId: <from step 1>, query: "${u.features.slice(0, 3).join(", ") || u.name}")`;
    }).join("\n");

    parts.push(
      "DOCS FIRST. You're writing code that uses libraries you haven't looked up:",
      libList,
      "",
      "Look up the docs NOW (resolve-library-id alone does NOT count — you must call query-docs):",
      suggestions,
    );
  }

  if (degraded.length > 0) {
    const degradedList = degraded.map(u => `  - ${u.name}`).join("\n");
    parts.push(
      "",
      "DOCS LOOKUP INCOMPLETE. You called resolve-library-id but query-docs never completed for:",
      degradedList,
      "",
      "Either retry query-docs, or use WebSearch/WebFetch as an alternative doc source.",
    );
  }

  const reason = parts.join("\n");
  const allBlocked = [...uncovered, ...degraded];
  debug("Blocking " + toolName + " on " + filePath, { uncovered: uncovered.map(u => u.name), degraded: degraded.map(u => u.name) });

  return { ok: false, reason, uncovered: allBlocked };
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
    const result = check(hookInput.tool_name, hookInput.tool_input || {});

    if (result.ok) {
      // Allow: exit 0, no output needed
      process.exit(0);
    } else {
      // Block: PreToolUse contract
      const output = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
        systemMessage: result.reason,
      });
      process.stdout.write(output + "\n");
      process.exit(0);
    }
  } catch (e) {
    logError("Gate failed", { error: e.message, stack: e.stack });
    // D1: Fail-CLOSED on internal errors — silent allow was the 4-day bypass
    const errMsg = "GATE INTERNAL ERROR: docs-guard crashed. Blocking as precaution. Error: " + (e.message || "unknown") + ". Try the operation again. If this persists, check the docs-guard log in your temp directory for details.";
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: errMsg,
      },
      systemMessage: errMsg,
    });
    process.stdout.write(output + "\n");
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { check, isParseable, PARSEABLE };
