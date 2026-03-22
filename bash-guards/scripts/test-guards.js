#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "validate-bash.js");

let pass = 0;
let fail = 0;

function check(expect, label, cmd) {
  const input = JSON.stringify({ tool_input: { command: cmd } });
  let exitCode;
  try {
    execSync(`node "${SCRIPT}"`, {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
    exitCode = 0;
  } catch (e) {
    exitCode = e.status;
  }

  const blocked = exitCode === 2;
  const ok = (expect === "block" && blocked) || (expect === "allow" && !blocked);

  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${label} (expected=${expect}, got exit=${exitCode})`);
    console.log(`      cmd: ${cmd}`);
  }
}

// ── Rule 1: find ──
check("block", "find at start",            "find . -name foo");
check("block", "find after semicolon",     "cd /tmp; find . -type f");
check("block", "find after &&",            "cd /tmp && find . -name f");
check("block", "find in subshell",         "(find . -name bar)");

// ── Rule 2: grep ──
check("block", "grep at start",            "grep -r foo src/");
check("block", "grep after pipe",          "ls | grep foo");
check("block", "grep after semicolon",     "cd src; grep -l bar *.ts");
check("block", "grep after &&",            "cd src && grep -rn baz .");
check("block", "egrep",                    "egrep 'pattern' file.txt");
check("block", "fgrep",                    "fgrep 'literal' file.txt");
check("allow", "rg.exe exemption",         "rg.exe --files | rg.exe foo");
check("allow", 'grep in string arg',       'echo "grep is cool"');

// ── Rule 3: truncation ──
check("block", "pipe to tail",             "eslint src/ | tail -5");
check("block", "pipe to head",             "cat foo.txt | head -20");
check("block", "pipe to less",             "git log | less");
check("block", "pipe to more",             "git diff | more");
check("block", "pipe to tail after &&",    "cd src && eslint . | tail -5");
check("allow", "tail as first command",    "tail -f /var/log/syslog");

// ── Rule 4: piping test output ──
check("block", "npm test piped",           "npm test | cat");
check("block", "pytest piped",             "pytest | cat");

// ── Rule 5: package runners ──
check("block", "npx",                      "npx eslint src/");
check("block", "bunx",                     "bunx vitest");
check("block", "pnpx",                     "pnpx tsc");
check("block", "yarn dlx",                 "yarn dlx create-next-app");
check("block", "pnpm dlx",                 "pnpm dlx degit");
check("block", "npm exec",                 "npm exec -- eslint .");
check("block", "yarn exec",                "yarn exec tsc");
check("block", "pnpm exec",               "pnpm exec jest");
check("block", "node_modules bin",         "node_modules/.bin/eslint src/");
check("block", "node_modules bin ./",      "./node_modules/.bin/jest");
check("block", "npx after &&",            "cd project && npx eslint .");

// ── Rule 6: test runners ──
check("block", "vitest",                   "vitest run");
check("block", "jest",                     "jest --coverage");
check("block", "mocha",                    "mocha test/");
check("block", "pytest",                   "pytest -v");
check("block", "phpunit",                  "phpunit tests/");
check("block", "rspec",                    "rspec spec/");
check("block", "cargo test",              "cargo test");
check("block", "go test",                 "go test ./...");
check("block", "dotnet test",             "dotnet test");
check("block", "deno test",               "deno test");
check("block", "node --test",             "node --test");
check("block", "npm test",                "npm test");
check("block", "npm run test",            "npm run test");
check("block", "yarn test",               "yarn test");
check("block", "pnpm test",               "pnpm test");
check("block", "bun test",                "bun test");
check("block", "bun run test",            "bun run test");

// ── Wrapper recursion ──
check("block", "bash -c grep",            "bash -c 'grep foo bar'");
check("block", "sh -c find",              "sh -c 'find . -name x'");
check("block", "bash -lc npx",            "bash -lc 'npx eslint'");

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
