#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "validate-bash.js");

let pass = 0;
let fail = 0;

function parseOutput(stdout) {
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout);
    const out = parsed?.hookSpecificOutput;
    if (out?.permissionDecision === "deny") {
      return { blocked: true, reason: out.permissionDecisionReason || "" };
    }
  } catch {}
  return null;
}

function check(expect, label, cmd, exactReason) {
  const input = JSON.stringify({ tool_input: { command: cmd } });
  let stdout = "";
  try {
    stdout = execSync(`node "${SCRIPT}"`, {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    }).toString();
  } catch (e) {
    stdout = "";
  }

  const result = parseOutput(stdout);
  const blocked = result !== null;
  const reason = result?.reason || "";

  if (expect === "block" && !blocked) {
    fail++;
    console.log(`FAIL: ${label} (expected=block, got=allow)`);
    console.log(`      cmd: ${cmd}`);
    return;
  }
  if (expect === "allow" && blocked) {
    fail++;
    console.log(`FAIL: ${label} (expected=allow, got=block reason="${reason}")`);
    console.log(`      cmd: ${cmd}`);
    return;
  }

  if (expect === "block" && exactReason && reason !== exactReason) {
    fail++;
    console.log(`FAIL: ${label} (reason mismatch)`);
    console.log(`      expected: "${exactReason}"`);
    console.log(`      got:      "${reason}"`);
    return;
  }

  pass++;
}

// ── Rule 1: find ──
check("block", "find at start",            "find . -name foo",             "find is banned. Use rg.exe instead.");
check("block", "find after semicolon",     "cd /tmp; find . -type f",      "find is banned. Use rg.exe instead.");
check("block", "find after &&",            "cd /tmp && find . -name f",    "find is banned. Use rg.exe instead.");
check("block", "find in subshell",         "(find . -name bar)",           "find is banned. Use rg.exe instead.");

// ── Rule 2: grep ──
check("block", "grep at start",            "grep -r foo src/",             "grep is banned. Use rg.exe instead.");
check("block", "grep after pipe",          "ls | grep foo",                "grep is banned. Use rg.exe instead.");
check("block", "grep after semicolon",     "cd src; grep -l bar *.ts",     "grep is banned. Use rg.exe instead.");
check("block", "grep after &&",            "cd src && grep -rn baz .",     "grep is banned. Use rg.exe instead.");
check("block", "egrep",                    "egrep 'pattern' file.txt",     "egrep is banned. Use rg.exe instead.");
check("block", "fgrep",                    "fgrep 'literal' file.txt",     "fgrep is banned. Use rg.exe instead.");
check("allow", "rg.exe exemption",         "rg.exe --files | rg.exe foo");
check("allow", "grep in string arg",       'echo "grep is cool"');

// ── Rule 3: truncation ──
check("block", "pipe to tail",             "eslint src/ | tail -5",        "Do not truncate output with tail. Read the full output directly.");
check("block", "pipe to head",             "cat foo.txt | head -20",       "Do not truncate output with head. Read the full output directly.");
check("block", "pipe to less",             "git log | less",               "Do not truncate output with less. Read the full output directly.");
check("block", "pipe to more",             "git diff | more",              "Do not truncate output with more. Read the full output directly.");
check("block", "pipe to tail after &&",    "cd src && eslint . | tail -5", "Do not truncate output with tail. Read the full output directly.");
check("allow", "tail as first command",    "tail -f /var/log/syslog");

// ── Rule 4: piping test output (hiding results) ──
check("block", "npm test piped",           "npm test | cat",               "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "pytest piped",             "pytest | cat",                 "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "npm test piped to rg",     "npm test | rg.exe PASS",      "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "npm run test piped",       "npm run test | cat",           "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "vitest piped",             "vitest | cat",                 "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "jest piped",               "jest --coverage | cat",        "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "cargo test piped",         "cargo test | cat",             "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "go test piped",            "go test ./... | cat",          "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "node --test piped",        "node --test | cat",            "Do not pipe test output. Run the test command directly and read the full output.");
check("allow", "echo test piped",          "echo test | cat");
check("allow", "node script with test in name piped", "node test-guards.js | cat");

// ── Rule 4 does NOT ban running tests ──
check("allow", "npm test",                 "npm test");
check("allow", "npm run test",             "npm run test");
check("allow", "vitest",                   "vitest run");
check("allow", "jest",                     "jest --coverage");
check("allow", "mocha",                    "mocha test/");
check("allow", "pytest",                   "pytest -v");
check("allow", "phpunit",                  "phpunit tests/");
check("allow", "rspec",                    "rspec spec/");
check("allow", "cargo test",              "cargo test");
check("allow", "go test",                 "go test ./...");
check("allow", "dotnet test",             "dotnet test");
check("allow", "deno test",               "deno test");
check("allow", "node --test",             "node --test");
check("allow", "yarn test",               "yarn test");
check("allow", "pnpm test",               "pnpm test");
check("allow", "bun test",                "bun test");
check("allow", "bun run test",            "bun run test");

// ── Rule 5: package runners ──
check("block", "npx",                      "npx eslint src/",              "Package runners (npx) are banned. Do not run arbitrary packages.");
check("block", "bunx",                     "bunx vitest",                  "Package runners (bunx) are banned. Do not run arbitrary packages.");
check("block", "pnpx",                     "pnpx tsc",                    "Package runners (pnpx) are banned. Do not run arbitrary packages.");
check("block", "yarn dlx",                 "yarn dlx create-next-app",     "Package runners (yarn dlx) are banned. Do not run arbitrary packages.");
check("block", "pnpm dlx",                 "pnpm dlx degit",              "Package runners (pnpm dlx) are banned. Do not run arbitrary packages.");
check("block", "npm exec",                 "npm exec -- eslint .",         "Package runners (npm exec) are banned. Do not run arbitrary packages.");
check("block", "yarn exec",                "yarn exec tsc",               "Package runners (yarn exec) are banned. Do not run arbitrary packages.");
check("block", "pnpm exec",               "pnpm exec jest",               "Package runners (pnpm exec) are banned. Do not run arbitrary packages.");
check("block", "node_modules bin",         "node_modules/.bin/eslint src/","Do not run binaries from node_modules/.bin/ directly. Use npm scripts from package.json instead.");
check("block", "node_modules bin ./",      "./node_modules/.bin/jest",     "Do not run binaries from node_modules/.bin/ directly. Use npm scripts from package.json instead.");
check("block", "node bypass via node",     "node node_modules/eslint/bin/eslint.js src/", "Do not run test/lint tools from node_modules/ by path. Use npm scripts from package.json instead.");
check("block", "node bypass with flags",   "node --no-warnings node_modules/eslint/bin/eslint.js src/ --max-warnings 0", "Do not run test/lint tools from node_modules/ by path. Use npm scripts from package.json instead.");
check("block", "node bypass vitest",       "node node_modules/vitest/vitest.mjs run", "Do not run test/lint tools from node_modules/ by path. Use npm scripts from package.json instead.");
check("allow", "node_modules non-tool",    "node node_modules/blowjob/index.js");
check("allow", "cat node_modules readme",  "cat node_modules/some-pkg/README.md");
check("block", "npx after &&",            "cd project && npx eslint .",    "Package runners (npx) are banned. Do not run arbitrary packages.");
check("allow", "npx skills find",        "npx skills find react");
check("allow", "npx skills add",         "npx skills add vercel-labs/agent-skills@react -g -y");
check("allow", "npx skills check",       "npx skills check");
check("allow", "npx skills update",      "npx skills update");
check("block", "npx not-skills",         "npx create-next-app",           "Package runners (npx) are banned. Do not run arbitrary packages.");

// ── Wrapper recursion ──
check("block", "bash -c grep",            "bash -c 'grep foo bar'",       "grep is banned. Use rg.exe instead.");
check("block", "sh -c find",              "sh -c 'find . -name x'",       "find is banned. Use rg.exe instead.");
check("block", "bash -lc npx",            "bash -lc 'npx eslint'",        "Package runners (npx) are banned. Do not run arbitrary packages.");

// ── Should ALLOW ──
check("allow", "git status",              "git status");
check("allow", "npm run lint",            "npm run lint");
check("allow", "npm run build",           "npm run build");
check("allow", "npm install",             "npm install");
check("allow", "ls -la",                  "ls -la");
check("allow", "echo hello",             "echo hello");
check("allow", "git diff",               "git diff HEAD");
check("allow", "cat package.json",       "cat package.json");
check("allow", "node script.js",         "node script.js");
check("allow", "npm run ci",             "npm run ci");
check("allow", "git log --oneline",      "git log --oneline");
check("allow", "empty command",          "");

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
