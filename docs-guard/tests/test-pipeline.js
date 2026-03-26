/**
 * Integration tests for the tracker + gate pipeline.
 * Tests HOOK BEHAVIOR, not internal state mechanics.
 *
 * Every test here answers one of:
 *   "Does this tool call get blocked or allowed?"
 *   "Does the hook output match the contract?"
 *   "Does the full resolve → query-docs → Write flow work?"
 *
 * Hook contract (docs.anthropic.com/en/docs/claude-code/hooks):
 *   exit 0 + no stdout         = allow
 *   exit 0 + JSON stdout       = decision in hookSpecificOutput
 *   exit 2 + stderr            = block (simple mode)
 *
 * PreToolUse deny JSON:
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
 *     permissionDecisionReason: "..." } }
 *
 * PostToolUse input uses tool_result (first-party docs field name).
 */

// Isolate from live session hooks
process.env.CLAUDE_CWD = "/test/pipeline/" + process.pid + "/" + Date.now();

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { clearState, recordLookup } = require("../src/state");

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
 * Run a hook script as subprocess with JSON on stdin.
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

  if (!result.stdout || !result.stdout.trim()) {
    return { ok: true };
  }

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
 * Run tracker subprocess. Returns { exitCode, stdout }.
 */
function runTracker(input) {
  const result = runHook(TRACKER, input);
  return { exitCode: result.exitCode, stdout: result.stdout };
}

// ─── Tracker: does looking up docs get recorded? ─────────────────

console.log("\n--- Tracker behavior ---\n");

test("resolve-library-id does NOT count as a doc lookup", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "next.js", query: "server actions" },
  });
  // Gate should still block — resolve alone is not enough
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import next from "next";\nexport default next;',
    },
  });
  assert(result.ok === false, "Should block — resolve-library-id alone is not a doc lookup");
});

test("resolve + query-docs counts as a doc lookup", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "next", query: "next.js" },
    tool_result: "- Context7-compatible library ID: /vercel/next.js\n- Description: Next.js docs",
  });
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/vercel/next.js", query: "app router middleware" },
  });
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import next from "next";\nexport default next;',
    },
  });
  assert(result.ok === true, "Should allow — resolve + query-docs is a complete lookup");
});

test("WebSearch counts as a doc lookup", () => {
  clearState();
  runTracker({
    tool_name: "WebSearch",
    tool_input: { query: "prisma client findMany documentation" },
  });
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/db.ts",
      content: 'import { PrismaClient } from "prisma";\nconst p = new PrismaClient();',
    },
  });
  assert(result.ok === true, "Should allow — WebSearch for prisma counts as lookup");
});

test("tracker produces no stdout (PostToolUse contract)", () => {
  clearState();
  const result = runTracker({
    tool_name: "WebSearch",
    tool_input: { query: "react documentation" },
  });
  assert(result.exitCode === 0, `Tracker must exit 0, got ${result.exitCode}`);
  assert(!result.stdout || result.stdout.trim() === "",
    `Tracker must produce no stdout, got: "${result.stdout}"`);
});

// ─── Gate: does it block/allow correctly? ────────────────────────

console.log("\n--- Gate behavior ---\n");

test("blocks Write with uncovered library", () => {
  clearState();
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import { useState } from "react";\nexport function App() { return useState(0); }',
    },
  });
  assert(result.ok === false, "Should block uncovered react");
  assert(result.reason.includes("react"), "Reason should mention react");
});

test("allows Write after doc lookup", () => {
  clearState();
  recordLookup("react", "useState hook", "context7");
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import { useState } from "react";\nexport function App() { return useState(0); }',
    },
  });
  assert(result.ok === true, "Should allow after lookup");
});

test("blocks only uncovered libraries when partially covered", () => {
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

test("allows Write with no imports", () => {
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

test("allows non-parseable files (json, md)", () => {
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

test("blocks Edit with uncovered library in new_string", () => {
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

test("allows Edit after lookup", () => {
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

// ─── Full pipeline: resolve → query-docs → Write ────────────────

console.log("\n--- Full pipeline ---\n");

test("resolve + query-docs + Write: allowed", () => {
  clearState();
  runTracker({
    tool_name: "mcp__context7__resolve-library-id",
    tool_input: { libraryName: "react", query: "useOptimistic" },
    tool_result: "- Context7-compatible library ID: /facebook/react\n- Description: React library",
  });
  runTracker({
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/facebook/react", query: "useOptimistic hook usage" },
  });
  const result = runGate({
    tool_name: "Write",
    tool_input: {
      file_path: "src/optimistic.tsx",
      content: 'import { useOptimistic } from "react";\nexport function C() { const [o] = useOptimistic(0); return o; }',
    },
  });
  assert(result.ok === true, "Full pipeline should allow after lookup");
});

test("gate blocks → resolve + query-docs → gate allows", () => {
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
    tool_result: "- Context7-compatible library ID: /colinhacks/zod\n- Description: Zod schema validation",
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

// ─── Edit with file-head reading ─────────────────────────────────

console.log("\n--- Edit file-head behavior ---\n");

test("Edit blocks for imported symbols used in new_string", () => {
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
  assert(result.ok === false, "Should block — react symbols in new_string");
  assert(result.reason.includes("react"), "Should mention react");
  assert(!result.reason.includes("zod"), "Should NOT mention zod (z not in new_string)");
});

test("Edit allows when all used libraries are looked up", () => {
  clearState();
  recordLookup("react", "useState useEffect hooks", "context7");
  recordLookup("zod", "schema validation", "context7");

  const tmpDir = path.join(os.tmpdir(), "docs-guard-test-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "component.tsx");
  fs.writeFileSync(tmpFile, [
    'import { useState } from "react";',
    'import { z } from "zod";',
    "",
    "export function MyComponent() { return <div />; }",
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
  assert(result.ok === true, "Should allow — both libs looked up");
});

test("Edit allows when new_string uses no imported symbols", () => {
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
      new_string: '// Routes added below\napp.get("/", (req, res) => res.send("ok"));',
    },
  });
  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);
  assert(result.ok === true, "Should allow — no imported symbols in new_string");
});

// ─── Hook output contract (prevents the 4-day bypass) ────────────

console.log("\n--- Hook output contract ---\n");

test("deny output has all required fields per docs", () => {
  clearState();
  const result = runHook(GATE, {
    tool_name: "Write",
    tool_input: {
      file_path: "src/app.tsx",
      content: 'import { useState } from "react";\nexport function App() { return useState(0); }',
    },
  });
  assert(result.exitCode === 0, "Must exit 0");
  assert(result.stdout, "Must produce stdout");
  const parsed = JSON.parse(result.stdout);
  // These three fields are REQUIRED per docs.anthropic.com/en/docs/claude-code/hooks
  assert(parsed.hookSpecificOutput.hookEventName === "PreToolUse",
    "REGRESSION: missing hookEventName — this caused the 4-day bypass");
  assert(parsed.hookSpecificOutput.permissionDecision === "deny",
    "Missing permissionDecision");
  assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("react"),
    "Missing or wrong permissionDecisionReason");
});

test("allow output has no stdout", () => {
  clearState();
  const result = runHook(GATE, {
    tool_name: "Write",
    tool_input: {
      file_path: "src/utils.ts",
      content: "export const add = (a: number, b: number) => a + b;",
    },
  });
  assert(result.exitCode === 0, "Must exit 0");
  assert(!result.stdout || !result.stdout.trim(), "Allow must produce no stdout");
});

test("malformed input produces deny (fail-closed)", () => {
  clearState();
  const result = runHook(GATE, "not valid json");
  assert(result.exitCode === 0, "Must exit 0");
  assert(result.stdout, "Must deny, not silent allow");
  const parsed = JSON.parse(result.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === "deny", "Must deny malformed input");
});

test("unknown tool produces deny (fail-closed)", () => {
  clearState();
  const result = runHook(GATE, {
    tool_name: "NotebookEdit",
    tool_input: { file_path: "notebook.ipynb", content: "import pandas as pd" },
  });
  assert(result.exitCode === 0, "Must exit 0");
  assert(result.stdout, "Must deny unknown tool");
  const parsed = JSON.parse(result.stdout);
  assert(parsed.hookSpecificOutput.hookEventName === "PreToolUse", "Missing hookEventName");
  assert(parsed.hookSpecificOutput.permissionDecision === "deny", "Must deny unknown tool");
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
