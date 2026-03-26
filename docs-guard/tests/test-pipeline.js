/**
 * Integration tests for the tracker + gate pipeline.
 * All tests use subprocess invocation matching the real hook runner contract.
 *
 * Hook contract (code.claude.com/docs/en/hooks):
 *   exit 0 + no stdout         = allow
 *   exit 0 + JSON stdout       = decision in hookSpecificOutput
 *   exit 2 + stderr            = block (simple mode, not used here)
 *   other exit                 = non-blocking error
 *
 * PreToolUse deny JSON:
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
 *     permissionDecisionReason: "..." }, systemMessage: "..." }
 *
 * PostToolUse input uses tool_response (not tool_result).
 */

// Isolate from live session hooks
process.env.CLAUDE_CWD = "/test/pipeline/" + process.pid + "/" + Date.now();

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
 * Returns { exitCode, stdout, stderr }.
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
 * Run gate and parse result strictly per docs contract.
 * NEVER silently treats bad JSON as allow.
 */
function runGate(input) {
  const result = runHook(GATE, input);
  assert(result.exitCode === 0, `Gate must exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);

  // No stdout = allow
  if (!result.stdout || !result.stdout.trim()) {
    return { ok: true };
  }

  // Has stdout — must be valid JSON with correct contract shape
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Gate stdout is not valid JSON: "${result.stdout.slice(0, 200)}"`);
  }

  const hso = parsed.hookSpecificOutput;
  assert(hso, "Gate JSON missing hookSpecificOutput");
  assert(hso.hookEventName === "PreToolUse", `hookEventName must be "PreToolUse", got "${hso.hookEventName}"`);

  if (hso.permissionDecision === "deny") {
    assert(typeof hso.permissionDecisionReason === "string" && hso.permissionDecisionReason.length > 0,
      "Deny must include non-empty permissionDecisionReason");
    return { ok: false, reason: hso.permissionDecisionReason };
  }

  return { ok: true };
}

/**
 * Run tracker. PostToolUse — should always exit 0 with no stdout.
 */
function runTracker(input) {
  const result = runHook(TRACKER, input);
  return { exitCode: result.exitCode, stdout: result.stdout };
}

// ─── State management tests ──────────────────────────────────────

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
  assert(hasLookup("react").found, "Expected to find react lookup");
  assert(!hasLookup("express").found, "Should not find express lookup");
});

test("hasLookup is case-insensitive", () => {
  clearState();
  recordLookup("React", "hooks API", "context7");
  assert(hasLookup("react").found, "Case-insensitive lookup failed");
});

test("hasLookup matches query containing library name", () => {
  clearState();
  recordLookup("", "how to use zod for validation", "web-search");
  assert(hasLookup("zod").found, "Should match zod from query text");
});

// ─── Tracker (PostToolUse) tests ─────────────────────────────────

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

test("tracker records context7 query-docs (with mapping)", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "next", query: "next.js" },
    tool_response: "- Context7-compatible library ID: /vercel/next.js\n- Description: Next.js docs",
  });
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/vercel/next.js", query: "app router middleware" },
  });
  const state = dumpState();
  assert(state.lookups.length === 1, `Expected 1 lookup, got ${state.lookups.length}`);
  assert(state.lookups[0].library === "next");
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

test("tracker always exits 0 with no stdout", () => {
  clearState();
  const result = runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "react", query: "hooks" },
  });
  assert(result.exitCode === 0, `Tracker should exit 0, got ${result.exitCode}`);
  assert(!result.stdout || result.stdout.trim() === "",
    `Tracker must produce no stdout, got: "${result.stdout}"`);
});

// ─── Gate (PreToolUse) tests ─────────────────────────────────────

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
      content: 'import { useState } from "react";\nexport function App() { const [x] = useState(0); return <div>{x}</div>; }',
    },
  });
  assert(result.ok === false, "Should block uncovered react usage");
  assert(result.reason.includes("react"), `Reason should mention react: ${result.reason}`);
});

test("gate allows Write after doc lookup", () => {
  clearState();
  recordLookup("react", "useState hook", "context7");
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import { useState } from "react";\nexport function App() { const [x] = useState(0); return <div>{x}</div>; }',
    },
  });
  assert(result.ok === true, "Should allow after lookup");
});

test("gate blocks only uncovered libraries (partial coverage)", () => {
  // Full subprocess isolation — prevents live hook state pollution
  const uniqueCwd = "/test/partial/" + process.pid + "/" + Date.now();
  const scriptDir = path.join(__dirname, "..", "..");
  const stdout = execSync(`node -e "${[
    `process.env.CLAUDE_CWD='${uniqueCwd}';`,
    `const s=require('./docs-guard/src/state');`,
    `const g=require('./docs-guard/src/gate');`,
    `s.clearState();`,
    `s.recordLookup('react','hooks','context7');`,
    `const r=g.check('Write',{file_path:'src/form.tsx',`,
    `content:'import { useState } from \\\"react\\\";\\n`,
    `import { z } from \\\"zod\\\";\\n`,
    `const schema = z.object({ name: z.string() });\\n`,
    `export function F() { const [v] = useState(0); return v; }'});`,
    `s.clearState();`,
    `console.log(JSON.stringify({ok:r.ok,zod:!!r.reason?.includes('zod'),react:!!r.reason?.includes('react')}));`,
  ].join("")}"`, { cwd: scriptDir, encoding: "utf8", timeout: 10000, env: { ...process.env, CLAUDE_CWD: uniqueCwd } }).trim();
  const r = JSON.parse(stdout);
  assert(r.ok === false, "Should block for uncovered zod");
  assert(r.zod === true, "Should mention zod");
  assert(r.react === false, "Should NOT mention react (covered)");
});

test("gate handles Edit tool (new_string)", () => {
  clearState();
  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: "src/api.ts",
      old_string: "// TODO",
      new_string: 'import express from "express";\nconst app = express();',
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
      new_string: 'import express from "express";\nconst app = express();',
    },
  });
  assert(result.ok === true, "Should allow express after lookup");
});

test("full pipeline: resolve + query-docs + gate allows", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "react", query: "useOptimistic" },
    tool_response: "- Context7-compatible library ID: /facebook/react\n- Description: React library",
  });
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/facebook/react", query: "useOptimistic hook usage" },
  });
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/optimistic.tsx",
      content: 'import { useOptimistic } from "react";\nexport function Counter() { const [o, add] = useOptimistic(0); return <div>{o}</div>; }',
    },
  });
  assert(result.ok === true, "Full pipeline should allow after lookup");
});

test("full pipeline: gate blocks then resolve + query-docs unblocks", () => {
  clearState();
  const blocked = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/schema.ts",
      content: 'import { z } from "zod";\nconst s = z.string();',
    },
  });
  assert(blocked.ok === false, "Should block first attempt");

  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "zod", query: "zod validation" },
    tool_response: "- Context7-compatible library ID: /colinhacks/zod\n- Description: Zod schema validation",
  });
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/colinhacks/zod", query: "schema validation" },
  });
  const allowed = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/schema.ts",
      content: 'import { z } from "zod";\nconst s = z.string();',
    },
  });
  assert(allowed.ok === true, "Should allow after lookup");
});

// ─── Edit with file-head reading tests ───────────────────────────

console.log("\n--- Edit file-head reading tests ---\n");

test("Edit reads imports from file on disk when new_string has no imports", () => {
  clearState();
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

  const result = runGate({
    tool_name: "Edit",
    tool_input: {
      file_path: tmpFile,
      old_string: "  const [val, setVal] = useState(0);",
      new_string: "  const [val, setVal] = useState(42);\n  useEffect(() => { console.log(val); }, [val]);",
    },
  });
  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);
  assert(result.ok === false, "Should block Edit using react symbols");
  assert(result.reason.includes("react"), "Should mention react");
  assert(!result.reason.includes("zod"), "Should NOT mention zod (z not in new_string)");
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
  assert(result.ok === false, "Should still block when file doesn't exist");
  assert(result.reason.includes("zod"), "Should catch zod from new_string fallback");
});

// ─── Edit scope precision tests ──────────────────────────────────

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
  assert(result.ok === false, "Should block for uncovered libs in new_string");
  assert(result.reason.includes("zod"), "Should mention zod");
});

test("Edit doesn't block for symbols only in old context", () => {
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
  assert(result.ok === true, "Should allow edit using only local variables");
});

// ─── Hook contract verification ──────────────────────────────────

console.log("\n--- Hook contract verification tests ---\n");

test("gate block: valid contract JSON with all required fields", () => {
  clearState();
  const result = runHook(GATE, {
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import { useState } from "react";\nexport function App() { const [x] = useState(0); return x; }',
    },
  });
  assert(result.exitCode === 0, `Must exit 0, got ${result.exitCode}`);
  assert(result.stdout, "Block must produce stdout");
  const parsed = JSON.parse(result.stdout);
  assert(parsed.hookSpecificOutput.hookEventName === "PreToolUse", "Missing hookEventName");
  assert(parsed.hookSpecificOutput.permissionDecision === "deny", "Missing permissionDecision");
  assert(parsed.hookSpecificOutput.permissionDecisionReason.length > 0, "Missing permissionDecisionReason");
  assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("react"), "Reason should mention react");
});

test("gate allow: no stdout", () => {
  clearState();
  const result = runHook(GATE, {
    tool_name: "Write",
    tool_input: {
      file_path: "src/utils.ts",
      content: "export const add = (a: number, b: number) => a + b;",
    },
  });
  assert(result.exitCode === 0, `Must exit 0, got ${result.exitCode}`);
  assert(!result.stdout || !result.stdout.trim(), `Allow must produce no stdout, got: "${result.stdout}"`);
});

test("gate malformed input: deny (fail-closed)", () => {
  clearState();
  const result = runHook(GATE, "not valid json at all");
  assert(result.exitCode === 0, `Must exit 0, got ${result.exitCode}`);
  assert(result.stdout, "Must produce deny stdout, not silent allow");
  const parsed = JSON.parse(result.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === "deny", "Must deny malformed input");
});

test("gate unknown tool: deny (fail-closed)", () => {
  clearState();
  const result = runHook(GATE, {
    tool_name: "NotebookEdit",
    tool_input: { file_path: "notebook.ipynb", content: "import pandas as pd" },
  });
  assert(result.exitCode === 0, `Must exit 0, got ${result.exitCode}`);
  assert(result.stdout, "Must produce deny stdout for unknown tool");
  const parsed = JSON.parse(result.stdout);
  assert(parsed.hookSpecificOutput.hookEventName === "PreToolUse", "Missing hookEventName");
  assert(parsed.hookSpecificOutput.permissionDecision === "deny", "Must deny unknown tool");
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
