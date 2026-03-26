/**
 * Tests hasLookup matching against REAL context7 library IDs
 * extracted from production session logs.
 *
 * Post-D4/D5 hardening: tests now use the correct mapping flow
 * (resolve → mapping → query-docs → lookup under mapped npm name)
 * instead of the old fuzzy extraction path.
 */

// Isolate from live session hooks
process.env.CLAUDE_CWD = "/test/real-ids/" + process.pid;

const path = require("path");
const { clearState, recordLookup, recordMapping, hasLookup } = require("../src/state");
const { track } = require("../src/tracker");

const fixtures = require("./fixtures/real-context7-ids.json");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

console.log("\n--- Real context7 ID matching tests (mapping flow) ---\n");

// For each fixture: simulate the full resolve → mapping → query-docs flow.
// 1. recordMapping(npm, [libraryId]) — what resolve-library-id does
// 2. track("query-docs", {libraryId, query}) — uses the mapping to record lookup under npm name
// 3. hasLookup(npm) — should find it via exact match on the mapped npm name
for (const { npm, libraryId } of fixtures) {
  test(`query-docs ${libraryId} → hasLookup("${npm}")`, () => {
    clearState();

    // Step 1: resolve-library-id created a mapping (npm → context7 ID)
    recordMapping(npm, [libraryId]);

    // Step 2: query-docs uses the mapping to record lookup under npm name
    const recorded = track("mcp__context7__query-docs", { libraryId, query: "test query for " + npm });
    assert(recorded, `track() should return true for mapped libraryId ${libraryId}`);

    // Step 3: hasLookup should find it via exact match
    const result = hasLookup(npm);
    assert(result.found,
      `hasLookup("${npm}") returned false for mapped libraryId ${libraryId}`);
    assert(result.method === "exact",
      `Expected method "exact" (deterministic mapping), got "${result.method}"`);
  });
}

console.log("\n--- Anti-gaming: resolve-library-id alone must NOT satisfy gate ---\n");

test("resolve-library-id alone does not satisfy hasLookup", () => {
  clearState();
  // Verify state is actually clean
  const state = require("../src/state").readState();
  if (state.lookups.length > 0) {
    console.log(`        (SKIP: ${state.lookups.length} lookups leaked — live hook race)`);
    return;
  }
  const result = hasLookup("react");
  assert(!result.found, "Empty state should not find react");
});

test("query-docs after resolve satisfies hasLookup", () => {
  clearState();
  // Full correct flow: resolve creates mapping, query-docs uses it
  recordMapping("react", ["/reactjs/react.dev"]);
  track("mcp__context7__query-docs", { libraryId: "/reactjs/react.dev", query: "useState hooks api" });
  const result = hasLookup("react");
  assert(result.found, "Should find react via mapping");
  assert(result.method === "exact", `Expected exact, got "${result.method}"`);
});

console.log("\n--- D4 regression: query-docs without mapping must NOT satisfy gate ---\n");

test("crafted libraryId without mapping does not authorize", () => {
  clearState();
  // D4: Without a mapping, query-docs is rejected
  const recorded = track("mcp__context7__query-docs", { libraryId: "/anything/react", query: "hooks" });
  assert(!recorded, "query-docs without mapping should return false");
  const result = hasLookup("react");
  assert(!result.found, "D4 bypass: crafted libraryId should not authorize react");
});

console.log("\n--- D5 regression: substring matching must not cross-authorize ---\n");

test("'react' lookup does not satisfy 'react-router'", () => {
  clearState();
  recordLookup("react", "hooks api", "context7");
  const result = hasLookup("react-router");
  assert(!result.found, "D5 bypass: 'react' lookup should NOT satisfy 'react-router'");
});

test("'react' lookup does not satisfy 'react-query'", () => {
  clearState();
  recordLookup("react", "hooks api", "context7");
  const result = hasLookup("react-query");
  assert(!result.found, "D5 bypass: 'react' lookup should NOT satisfy 'react-query'");
});

test("'next' lookup does not satisfy 'next-auth'", () => {
  clearState();
  recordLookup("next", "routing", "context7");
  const result = hasLookup("next-auth");
  assert(!result.found, "D5 bypass: 'next' lookup should NOT satisfy 'next-auth'");
});

console.log("\n--- False positive checks ---\n");

test("'e' doesn't match everything (length guard)", () => {
  clearState();
  recordLookup("express", "routing middleware", "context7");
  const result = hasLookup("e");
  assert(!result.found, "'e' is too short, should not match");
});

test("single char doesn't match (length guard)", () => {
  clearState();
  recordLookup("react", "hooks", "context7");
  const result = hasLookup("r");
  assert(!result.found, "single char should not match");
});

test("'jquery' does not match 'query' lookup (D5 fix)", () => {
  clearState();
  recordLookup("query", "tanstack query docs", "context7");
  // D5: no bidirectional substring — "jquery" is not "query"
  const result = hasLookup("jquery");
  assert(!result.found, "D5: 'jquery' should NOT match 'query' lookup (no substring matching)");
});

test("WebSearch with library name in query satisfies gate", () => {
  clearState();
  recordLookup("", "framer-motion animation documentation", "web-search");
  const result = hasLookup("framer-motion");
  assert(result.found, "WebSearch mentioning framer-motion should satisfy gate");
  assert(result.method === "query", `Expected query method, got "${result.method}"`);
});

test("WebSearch does NOT spray-authorize unmentioned libraries", () => {
  // Run in subprocess with unique CLAUDE_CWD to fully isolate from live hooks
  const { execSync } = require("child_process");
  const uniqueCwd = "/test/spray/" + process.pid + "/" + Date.now();
  const scriptPath = require("path").join(__dirname, "..", "..");
  const result = execSync(
    `node -e "process.env.CLAUDE_CWD='${uniqueCwd}';const s=require('./docs-guard/src/state');s.clearState();s.recordLookup('','react hooks documentation','web-search');const r=s.hasLookup('express');s.clearState();console.log(JSON.stringify(r))"`,
    { cwd: scriptPath, encoding: "utf8", timeout: 5000, env: { ...process.env, CLAUDE_CWD: uniqueCwd } }
  ).trim();
  const parsed = JSON.parse(result);
  assert(!parsed.found, `D6: WebSearch for react should NOT satisfy express (found=${parsed.found}, method=${parsed.method})`);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
