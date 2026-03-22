#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const { mkdirSync, writeFileSync, rmSync } = require("fs");
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

// ── Rule 4b: test:* script variants are test commands ──
check("block", "npm run test:coverage piped", "npm run test:coverage | cat", "Do not pipe test output. Run the test command directly and read the full output.");
check("block", "npm test:unit piped",     "npm test:unit | cat",           "Do not pipe test output. Run the test command directly and read the full output.");
check("allow", "npm run test:coverage",   "npm run test:coverage");

// ── Rule: no redirecting test output to files ──
check("block", "npm test > file",         "npm run test:coverage > /tmp/cov.txt 2>&1", "Do not redirect test output to a file (/tmp/cov.txt). Read the full output directly.");
check("block", "npm test > log",          "npm test > test.log",           "Do not redirect test output to a file (test.log). Read the full output directly.");
check("block", "jest > file",             "jest --coverage > results.txt", "Do not redirect test output to a file (results.txt). Read the full output directly.");
check("block", "pytest > file",           "pytest > out.txt",              "Do not redirect test output to a file (out.txt). Read the full output directly.");
check("block", "vitest 2> file",          "vitest run 2> errors.log",      "Do not redirect test output to a file (errors.log). Read the full output directly.");
check("allow", "echo > file ok",          "echo hello > output.txt");
check("allow", "git log > file ok",       "git log --oneline > log.txt");

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

// ── Rule: no silent/quiet on test/lint ──
check("block", "npm test --silent",       "npm test --silent",             "Do not suppress test/lint output with npm --silent/--quiet/--reporter. Read the full output.");
check("block", "jest --silent",           "jest --silent",                 "Do not suppress test/lint output with jest --silent/--quiet/--reporter. Read the full output.");
check("block", "eslint --quiet",          "eslint src/ --quiet",           "Do not suppress test/lint output with eslint --silent/--quiet/--reporter. Read the full output.");
check("block", "vitest --silent",         "vitest run --silent",           "Do not suppress test/lint output with vitest --silent/--quiet/--reporter. Read the full output.");
check("block", "pytest --quiet",          "pytest --quiet",                "Do not suppress test/lint output with pytest --silent/--quiet/--reporter. Read the full output.");
check("allow", "npm test normal",         "npm test");
check("allow", "git log --quiet",         "git log --quiet");

// ── Rule: no /dev/null redirects ──
check("block", "npm test 2>/dev/null",    "npm test 2>/dev/null",          "Do not redirect output to /dev/null. Read the full output.");
check("block", "vitest > /dev/null",      "vitest run > /dev/null",        "Do not redirect output to /dev/null. Read the full output.");
check("block", "jest > /dev/null 2>&1",   "jest --coverage > /dev/null 2>&1", "Do not redirect output to /dev/null. Read the full output.");
check("block", "eslint 2>&1 >/dev/null",  "eslint src/ 2>&1 > /dev/null",  "Do not redirect output to /dev/null. Read the full output.");
check("allow", "echo to file",           "echo hello > output.txt");

// ── Rule: no --loglevel suppress ──
check("block", "npm test loglevel silent", "npm test --loglevel silent",   "Do not suppress output with npm --loglevel. Read the full output.");
check("block", "npm test loglevel error",  "npm test --loglevel error",    "Do not suppress output with npm --loglevel. Read the full output.");
check("block", "npm test loglevel=silent", "npm test --loglevel=silent",   "Do not suppress output with npm --loglevel. Read the full output.");

// ── Rule: no --reporter suppress ──
check("block", "vitest reporter dot",     "vitest run --reporter=dot",     "Do not suppress test/lint output with vitest --silent/--quiet/--reporter. Read the full output.");
check("block", "mocha reporter dot",      "mocha --reporter dot",          "Do not suppress test/lint output with mocha --silent/--quiet/--reporter. Read the full output.");
check("block", "jest reporters",          "jest --reporters=default --silent", "Do not suppress test/lint output with jest --silent/--quiet/--reporter. Read the full output.");

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

// ── Package.json standards checks ──
// Create temp dirs with different configs

const TMP = path.join(__dirname, "..", ".tmp-test");
const mkTmp = (name, pkgJson, eslintConfig) => {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
  if (eslintConfig) writeFileSync(path.join(dir, "eslint.config.js"), eslintConfig);
  return dir;
};

const badLint = mkTmp("bad-lint", { scripts: { lint: "eslint src/" } });
const goodLint = mkTmp("good-lint", { scripts: { lint: "eslint src/ --no-inline-config" } });
const configLint = mkTmp("config-lint", { scripts: { lint: "eslint src/" } }, "module.exports = [{ linterOptions: { noInlineConfig: true } }]");
const noScripts = mkTmp("no-scripts", {});
const noLint = mkTmp("no-lint", { scripts: { build: "tsc" } });

function checkCwd(expect, label, cmd, cwd, exactReason) {
  const input = JSON.stringify({ tool_input: { command: cmd }, cwd });
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

  if (expect === "block" && !blocked) {
    fail++;
    console.log(`FAIL: ${label} (expected=block, got=allow)`);
    console.log(`      cmd: ${cmd} | cwd: ${cwd}`);
    return;
  }
  if (expect === "allow" && blocked) {
    fail++;
    console.log(`FAIL: ${label} (expected=allow, got=block reason="${result.reason}")`);
    console.log(`      cmd: ${cmd} | cwd: ${cwd}`);
    return;
  }
  if (expect === "block" && exactReason && result.reason !== exactReason) {
    fail++;
    console.log(`FAIL: ${label} (reason mismatch)`);
    console.log(`      expected: "${exactReason}"`);
    console.log(`      got:      "${result.reason}"`);
    return;
  }
  pass++;
}

checkCwd("block", "lint missing --no-inline-config", "npm run lint", badLint);
checkCwd("allow", "lint has --no-inline-config",     "npm run lint", goodLint);
checkCwd("allow", "lint config file has noInlineConfig", "npm run lint", configLint);
checkCwd("allow", "no scripts in package.json",      "npm run lint", noScripts);
checkCwd("allow", "no lint script",                   "npm run build", noLint);
checkCwd("allow", "git status unaffected",            "git status", badLint);
checkCwd("block", "yarn lint missing config",         "yarn lint", badLint);
checkCwd("block", "pnpm run lint missing config",     "pnpm run lint", badLint);
checkCwd("allow", "npm test not checked",             "npm test", badLint);

// Cleanup
rmSync(TMP, { recursive: true, force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
