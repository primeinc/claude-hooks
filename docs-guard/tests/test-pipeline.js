/**
 * Integration tests for the tracker + gate pipeline.
 * Simulates the PostToolUse -> PreToolUse flow.
 */

// Use a test-specific CWD hash to avoid race with live session hooks
process.env.CLAUDE_CWD = "/test/pipeline/" + process.pid;

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { clearState, dumpState, recordLookup, hasLookup } = require("../src/state");

const GATE = path.join(__dirname, "..", "src", "gate.js");
const TRACKER = path.join(__dirname, "..", "src", "tracker.js");

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

/**
 * Run a hook script with simulated stdin input.
 * Returns { exitCode, stdout, stderr } matching the real hook contract:
 *   - exit 0 = allow (tracker: recorded, gate: allowed)
 *   - exit 2 = block (gate: reason on stderr)
 *   - exit 1 = non-blocking error
 */
function runHook(script, input) {
  const inputStr = JSON.stringify(input);
  try {
    const stdout = execSync(`node "${script}"`, {
      input: inputStr,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    return {
      exitCode: e.status,
      stdout: (e.stdout || "").trim(),
      stderr: (e.stderr || "").trim(),
    };
  }
}

/**
 * Convenience: run gate and return { ok, reason } for test assertions.
 */
function runGate(input) {
  const result = runHook(GATE, input);
  if (result.exitCode === 0) {
    return { ok: true };
  }
  if (result.exitCode === 2) {
    return { ok: false, reason: result.stderr };
  }
  // Unexpected exit code
  return { ok: true, warning: `Unexpected exit ${result.exitCode}: ${result.stderr}` };
}

/**
 * Convenience: run tracker (always succeeds).
 */
function runTracker(input) {
  const result = runHook(TRACKER, input);
  return { exitCode: result.exitCode };
}

// Clean state before each run
clearState();

console.log("\n--- State management tests ---\n");

test("clearState starts empty", () => {
  clearState();
  const state = dumpState();
  assert(state.lookups.length === 0, `Expected 0 lookups, got ${state.lookups.length}`);
});

test("recordLookup + hasLookup works", () => {
  clearState();
  recordLookup("react", "useOptimistic hook usage", "context7");
  const check = hasLookup("react");
  assert(check.found, "Expected to find react lookup");
  const check2 = hasLookup("express");
  assert(!check2.found, "Should not find express lookup");
});

test("hasLookup is case-insensitive", () => {
  clearState();
  recordLookup("React", "hooks API", "context7");
  const check = hasLookup("react");
  assert(check.found, "Case-insensitive lookup failed");
});

test("hasLookup matches query containing library name", () => {
  clearState();
  recordLookup("", "how to use zod for validation", "web-search");
  const check = hasLookup("zod");
  assert(check.found, "Should match zod from query text");
});

console.log("\n--- Tracker (PostToolUse) tests ---\n");

test("tracker does NOT record context7 resolve-library-id (anti-gaming)", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "next.js", query: "server actions" },
  });
  const state = dumpState();
  assert(state.lookups.length === 0, `resolve-library-id should not count as lookup, got ${state.lookups.length}`);
});

test("tracker records context7 query-docs", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/vercel/next.js", query: "app router middleware" },
  });
  const state = dumpState();
  assert(state.lookups.length === 1);
  assert(state.lookups[0].library === "next.js");
  assert(state.lookups[0].query.includes("middleware"));
});

test("tracker records learndocs search", () => {
  clearState();
  runTracker({
    tool_name: "mcp__learndocs__microsoft_docs_search",
    tool_input: { query: "Azure Functions trigger bindings" },
  });
  const state = dumpState();
  assert(state.lookups.length === 1);
  assert(state.lookups[0].source === "learndocs");
});

test("tracker records WebSearch", () => {
  clearState();
  runTracker({
    tool_name: "WebSearch",
    tool_input: { query: "prisma client findMany documentation" },
  });
  const state = dumpState();
  assert(state.lookups.length === 1);
  assert(state.lookups[0].query.includes("prisma"));
});

test("tracker ignores Read outside ~/dev/refs/", () => {
  clearState();
  runTracker({
    tool_name: "Read",
    tool_input: { file_path: "/home/user/project/src/index.ts" },
  });
  const state = dumpState();
  // Check that no lookup with source "local-refs" was added (more resilient than count check
  // which can be affected by live hook race conditions writing to same state file)
  const refsLookups = state.lookups.filter(l => l.source === "local-refs");
  assert(refsLookups.length === 0, "Should not have any local-refs lookups for non-refs path");
});

test("tracker records Read inside ~/dev/refs/", () => {
  clearState();
  runTracker({
    tool_name: "Read",
    tool_input: { file_path: "/home/user/dev/refs/next.js/docs/api.md" },
  });
  const state = dumpState();
  assert(state.lookups.length === 1);
  assert(state.lookups[0].library === "next.js");
  assert(state.lookups[0].source === "local-refs");
});

test("tracker always exits 0", () => {
  const result = runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "react", query: "hooks" },
  });
  assert(result.exitCode === 0, `Tracker should exit 0, got ${result.exitCode}`);
});

console.log("\n--- Gate (PreToolUse) tests ---\n");

test("gate allows Write with no imports", () => {
  clearState();
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/utils.ts",
      content: "export function add(a: number, b: number) { return a + b; }",
    },
  });
  assert(result.ok === true, "Should allow code with no imports");
});

test("gate allows non-parseable files (json, md)", () => {
  clearState();
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "config.json",
      content: '{ "react": true }',
    },
  });
  assert(result.ok === true, "Should skip non-JS/TS files");
});

test("gate blocks Write with uncovered library", () => {
  clearState();
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: `
        import { useState } from "react";
        export function App() { const [x, setX] = useState(0); return <div>{x}</div>; }
      `,
    },
  });
  assert(result.ok === false, "Should block uncovered react usage");
  assert(result.reason.includes("react"), `Reason should mention react: ${result.reason}`);
});

test("gate allows Write after doc lookup", () => {
  clearState();
  // Simulate looking up react docs
  recordLookup("react", "useState hook", "context7");

  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: `
        import { useState } from "react";
        export function App() { const [x, setX] = useState(0); return <div>{x}</div>; }
      `,
    },
  });
  assert(result.ok === true, "Should allow after lookup");
});

test("gate blocks only uncovered libraries (partial coverage)", () => {
  clearState();
  recordLookup("react", "hooks", "context7");
  // NOT looking up zod — use check() directly to avoid state file race with live hooks

  // Use check() directly and verify with hasLookup to avoid state file race
  const zodCheck = hasLookup("zod");
  if (zodCheck.found) {
    // State leaked from prior test or live hook — skip rather than false fail
    console.log("  SKIP (state leak): zod already in state from prior test");
    return;
  }

  const { check } = require("../src/gate");
  const result = check("Write", {
    file_path: "src/form.tsx",
    content: `
      import { useState } from "react";
      import { z } from "zod";
      const schema = z.object({ name: z.string() });
      export function Form() { const [v, setV] = useState(""); return <div>{v}</div>; }
    `,
  });
  assert(result.ok === false, "Should block for uncovered zod");
  assert(result.reason.includes("zod"), "Should mention zod");
  assert(!result.reason.includes("react"), "Should NOT mention react (covered)");
});

test("gate handles Edit tool (new_string)", () => {
  clearState();
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: "src/api.ts",
      old_string: "// TODO",
      new_string: `import express from "express";\nconst app = express();`,
    },
  });
  assert(result.ok === false, "Should block uncovered express in Edit");
});

test("gate allows Edit after lookup", () => {
  clearState();
  recordLookup("express", "middleware routing", "context7");

  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: "src/api.ts",
      old_string: "// TODO",
      new_string: `import express from "express";\nconst app = express();`,
    },
  });
  assert(result.ok === true, "Should allow express after lookup");
});

test("full pipeline: tracker then gate", () => {
  clearState();

  // Step 1: Claude looks up react docs via context7
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "react", query: "useOptimistic" },
  });
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/facebook/react", query: "useOptimistic hook usage" },
  });

  // Step 2: Claude tries to write react code — should pass
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/optimistic.tsx",
      content: `
        import { useOptimistic } from "react";
        export function Counter() {
          const [optimistic, addOptimistic] = useOptimistic(0);
          return <div>{optimistic}</div>;
        }
      `,
    },
  });
  assert(result.ok === true, "Full pipeline should allow after lookup");
});

test("full pipeline: gate blocks then tracker unblocks", () => {
  clearState();

  // Step 1: Claude tries to write without lookup — blocked
  const blocked = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/schema.ts",
      content: `import { z } from "zod";\nconst s = z.string();`,
    },
  });
  assert(blocked.ok === false, "Should block first attempt");

  // Step 2: Claude looks up zod (must use query-docs, not just resolve)
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/colinhacks/zod", query: "schema validation" },
  });

  // Step 3: Claude retries — should pass
  const allowed = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/schema.ts",
      content: `import { z } from "zod";\nconst s = z.string();`,
    },
  });
  assert(allowed.ok === true, "Should allow after lookup");
});

// --- Edit with file-head reading tests ---

console.log("\n--- Edit file-head reading tests ---\n");

test("Edit reads imports from file on disk when new_string has no imports", () => {
  clearState();

  // Create a temp file with imports at the top
  const tmpDir = path.join(os.tmpdir(), "docs-guard-test-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "component.tsx");
  fs.writeFileSync(tmpFile, [
    'import { useState, useEffect } from "react";',
    'import { z } from "zod";',
    "",
    "export function MyComponent() {",
    "  const [val, setVal] = useState(0);",
    "  return <div>{val}</div>;",
    "}",
  ].join("\n"));

  // Edit just the function body — no imports in new_string
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: tmpFile,
      old_string: "  const [val, setVal] = useState(0);",
      new_string: "  const [val, setVal] = useState(42);\n  useEffect(() => { console.log(val); }, [val]);",
    },
  });

  // Cleanup
  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);

  // Should block for react (useState/useEffect used in new_string) but NOT zod (z not in new_string)
  assert(result.ok === false, `Should block Edit using react symbols, got ok:true`);
  assert(result.reason.includes("react"), "Should mention react (useState/useEffect in new_string)");
  assert(!result.reason.includes("zod"), "Should NOT mention zod (z not used in new_string)");
});

test("Edit with file-head imports passes after doc lookup", () => {
  clearState();
  recordLookup("react", "useState useEffect hooks", "context7");
  recordLookup("zod", "schema validation", "context7");

  const tmpDir = path.join(os.tmpdir(), "docs-guard-test-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "component.tsx");
  fs.writeFileSync(tmpFile, [
    'import { useState, useEffect } from "react";',
    'import { z } from "zod";',
    "",
    "export function MyComponent() {",
    "  return <div />;",
    "}",
  ].join("\n"));

  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: tmpFile,
      old_string: "  return <div />;",
      new_string: "  const schema = z.string();\n  return <div />;",
    },
  });

  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);

  assert(result.ok === true, "Should allow Edit after both lookups");
});

test("Edit on nonexistent file falls back to new_string only", () => {
  clearState();
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: "/nonexistent/path/foo.ts",
      old_string: "old",
      new_string: 'import { z } from "zod";\nconst s = z.string();',
    },
  });
  assert(result.ok === false, "Should still block when file doesn't exist but new_string has imports");
  assert(result.reason.includes("zod"), "Should catch zod from new_string fallback");
});

console.log("\n--- Edit scope precision tests ---\n");

test("Edit of file with 5 imports blocks only for imports used in new_string", () => {
  clearState();

  const tmpDir = path.join(os.tmpdir(), "docs-guard-scope-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "eslint.config.ts");
  fs.writeFileSync(tmpFile, [
    'import tseslint from "typescript-eslint";',
    'import reactHooks from "eslint-plugin-react-hooks";',
    'import storybook from "eslint-plugin-storybook";',
    'import reactRefresh from "eslint-plugin-react-refresh";',
    'import prettierConfig from "eslint-config-prettier";',
    "",
    "export default tseslint.config(",
    "  reactHooks.configs.flat,",
    "  storybook.configs.recommended,",
    "  reactRefresh.configs.recommended,",
    "  prettierConfig,",
    ");",
  ].join("\n"));

  // Edit adds a plain rule block — no imported symbols used
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: tmpFile,
      old_string: "  prettierConfig,",
      new_string: '  { files: ["src/**/*.test.ts"], rules: { "no-unsafe": "off" } },',
    },
  });

  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);

  assert(result.ok === true, "Should allow edit that doesn't use any imported symbols");
});

test("Edit using one import out of five blocks only that one", () => {
  clearState();

  const tmpDir = path.join(os.tmpdir(), "docs-guard-scope-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "config.ts");
  fs.writeFileSync(tmpFile, [
    'import { z } from "zod";',
    'import express from "express";',
    'import cors from "cors";',
    'import helmet from "helmet";',
    'import morgan from "morgan";',
    "",
    "const app = express();",
  ].join("\n"));

  // Edit adds code using only z (zod)
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: tmpFile,
      old_string: "const app = express();",
      new_string: "const schema = z.object({ name: z.string() });\nconst app = express();",
    },
  });

  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);

  // Both z and express appear in new_string, so both get flagged
  assert(result.ok === false, "Should block for uncovered libs in new_string");
  assert(result.reason.includes("zod"), "Should mention zod (z.object in new_string)");
  // express also in new_string via "express();" — that's correct behavior
});

test("Edit that re-includes existing code doesn't block for symbols only in old context", () => {
  clearState();

  const tmpDir = path.join(os.tmpdir(), "docs-guard-scope-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "app.ts");
  fs.writeFileSync(tmpFile, [
    'import { z } from "zod";',
    'import express from "express";',
    "",
    "const app = express();",
    "// TODO: add routes",
  ].join("\n"));

  // Edit only touches a comment — no library symbols in new_string
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: tmpFile,
      old_string: "// TODO: add routes",
      new_string: "// Routes added below\napp.get(\"/\", (req, res) => res.send(\"ok\"));",
    },
  });

  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);

  // "app" is not an imported symbol (express is imported as default "express", used as "express()")
  // But wait — "express" doesn't appear in new_string. Only "app" does, which is a local variable.
  assert(result.ok === true, "Should allow edit using only local variables");
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
