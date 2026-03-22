#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "validate-bash.js");
const RULES = JSON.parse(readFileSync(path.join(__dirname, "..", "rules.json"), "utf8"));

// Resolve a rule message by ID with template vars, so tests don't hardcode strings
function msg(ruleId, vars = {}) {
  const rule = RULES.rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`Unknown rule ID: ${ruleId}`);
  let m = rule.message;
  for (const [k, v] of Object.entries(vars)) {
    m = m.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return m;
}

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

// ── Rule: find ──
check("block", "find at start",            "find . -name foo",             msg("no-find", {cmd:"find"}));
check("block", "find after semicolon",     "cd /tmp; find . -type f",      msg("no-find", {cmd:"find"}));
check("block", "find after &&",            "cd /tmp && find . -name f",    msg("no-find", {cmd:"find"}));
check("block", "find in subshell",         "(find . -name bar)",           msg("no-find", {cmd:"find"}));

// ── Rule: grep ──
check("block", "grep at start",            "grep -r foo src/",             msg("no-grep", {cmd:"grep"}));
check("block", "grep after pipe",          "ls | grep foo",                msg("no-grep", {cmd:"grep"}));
check("block", "grep after semicolon",     "cd src; grep -l bar *.ts",     msg("no-grep", {cmd:"grep"}));
check("block", "grep after &&",            "cd src && grep -rn baz .",     msg("no-grep", {cmd:"grep"}));
check("block", "egrep",                    "egrep 'pattern' file.txt",     msg("no-grep", {cmd:"egrep"}));
check("block", "fgrep",                    "fgrep 'literal' file.txt",     msg("no-grep", {cmd:"fgrep"}));
check("allow", "rg.exe exemption",         "rg.exe --files | rg.exe foo");
check("allow", "grep in string arg",       'echo "grep is cool"');
check("block", "grep with rg.exe in string","echo 'use rg.exe' && grep -r secret .", msg("no-grep", {cmd:"grep"}));
check("block", "grep with rg.exe in arg",  "grep -r rg.exe.bak .",          msg("no-grep", {cmd:"grep"}));

// ── Rule: truncation ──
check("block", "pipe to tail",             "eslint src/ | tail -5",        msg("no-test-pipe"));
check("block", "pipe to head",             "cat foo.txt | head -20",       msg("no-truncation", {cmd:"head"}));
check("block", "pipe to less",             "git log | less",               msg("no-truncation", {cmd:"less"}));
check("block", "pipe to more",             "git diff | more",              msg("no-truncation", {cmd:"more"}));
check("block", "pipe to tail after &&",    "cd src && eslint . | tail -5", msg("no-test-pipe"));
check("allow", "tail as first command",    "tail -f /var/log/syslog");

// ── Rule: piping test output ──
check("block", "npm test piped",           "npm test | cat",               msg("no-test-pipe"));
check("block", "pytest piped",             "pytest | cat",                 msg("no-test-pipe"));
check("block", "npm test piped to rg",     "npm test | rg.exe PASS",      msg("no-test-pipe"));
check("block", "npm run test piped",       "npm run test | cat",           msg("no-test-pipe"));
check("block", "vitest piped",             "vitest | cat",                 msg("no-test-pipe"));
check("block", "jest piped",               "jest --coverage | cat",        msg("no-test-pipe"));
check("block", "cargo test piped",         "cargo test | cat",             msg("no-test-pipe"));
check("block", "go test piped",            "go test ./... | cat",          msg("no-test-pipe"));
check("block", "node --test piped",        "node --test | cat",            msg("no-test-pipe"));
check("allow", "echo test piped",          "echo test | cat");
check("allow", "node script with test in name piped", "node test-guards.js | cat");

// ── Running tests is allowed ──
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

// ── test:* script variants are test commands ──
check("block", "npm run test:coverage piped", "npm run test:coverage | cat", msg("no-test-pipe"));
check("block", "npm test:unit piped",     "npm test:unit | cat",           msg("no-test-pipe"));
check("allow", "npm run test:coverage",   "npm run test:coverage");

// ── No redirecting test output to files ──
check("block", "npm test > file",         "npm run test:coverage > /tmp/cov.txt 2>&1", msg("no-test-redirect", {target:"/tmp/cov.txt"}));
check("block", "npm test > log",          "npm test > test.log",           msg("no-test-redirect", {target:"test.log"}));
check("block", "jest > file",             "jest --coverage > results.txt", msg("no-test-redirect", {target:"results.txt"}));
check("block", "pytest > file",           "pytest > out.txt",              msg("no-test-redirect", {target:"out.txt"}));
check("block", "vitest 2> file",          "vitest run 2> errors.log",      msg("no-test-redirect", {target:"errors.log"}));
check("allow", "echo > file ok",          "echo hello > output.txt");
check("allow", "git log > file ok",       "git log --oneline > log.txt");

// ── Package runners ──
check("block", "npx",                      "npx eslint src/",              msg("no-package-runners", {cmd:"npx"}));
check("block", "bunx",                     "bunx vitest",                  msg("no-package-runners", {cmd:"bunx"}));
check("block", "pnpx",                     "pnpx tsc",                    msg("no-package-runners", {cmd:"pnpx"}));
check("block", "yarn dlx",                 "yarn dlx create-next-app",     msg("no-package-runner-dlx", {cmd:"yarn", sub:"dlx"}));
check("block", "pnpm dlx",                 "pnpm dlx degit",              msg("no-package-runner-dlx", {cmd:"pnpm", sub:"dlx"}));
check("block", "npm exec",                 "npm exec -- eslint .",         msg("no-package-runner-exec", {cmd:"npm", sub:"exec"}));
check("block", "yarn exec",                "yarn exec tsc",               msg("no-package-runner-exec", {cmd:"yarn", sub:"exec"}));
check("block", "pnpm exec",               "pnpm exec jest",               msg("no-package-runner-exec", {cmd:"pnpm", sub:"exec"}));
check("block", "node_modules bin",         "node_modules/.bin/eslint src/", msg("no-node-modules-bin"));
check("block", "node_modules bin ./",      "./node_modules/.bin/jest",     msg("no-node-modules-bin"));
check("block", "node bypass via node",     "node node_modules/eslint/bin/eslint.js src/", msg("no-test-tool-by-path"));
check("block", "node bypass with flags",   "node --no-warnings node_modules/eslint/bin/eslint.js src/ --max-warnings 0", msg("no-test-tool-by-path"));
check("block", "node bypass vitest",       "node node_modules/vitest/vitest.mjs run", msg("no-test-tool-by-path"));
check("allow", "node_modules non-tool",    "node node_modules/blowjob/index.js");
check("allow", "cat node_modules readme",  "cat node_modules/some-pkg/README.md");
check("allow", "node -e with node_modules string", 'node -e "console.log(node_modules/eslint)"');
check("block", "npx after &&",            "cd project && npx eslint .",    msg("no-package-runners", {cmd:"npx"}));
check("allow", "npx skills find",        "npx skills find react");
check("allow", "npx skills add",         "npx skills add vercel-labs/agent-skills@react -g -y");
check("allow", "npx skills check",       "npx skills check");
check("allow", "npx skills update",      "npx skills update");
check("block", "npx not-skills",         "npx create-next-app",           msg("no-package-runners", {cmd:"npx"}));

// ── No silent/quiet on test/lint ──
check("block", "npm test --silent",       "npm test --silent",             msg("no-silent-tests", {cmd:"npm"}));
check("block", "jest --silent",           "jest --silent",                 msg("no-silent-tests", {cmd:"jest"}));
check("block", "eslint --quiet",          "eslint src/ --quiet",           msg("no-silent-tests", {cmd:"eslint"}));
check("block", "vitest --silent",         "vitest run --silent",           msg("no-silent-tests", {cmd:"vitest"}));
check("block", "pytest --quiet",          "pytest --quiet",                msg("no-silent-tests", {cmd:"pytest"}));
check("allow", "npm test normal",         "npm test");
check("allow", "git log --quiet",         "git log --quiet");
check("allow", "npm install --quiet",     "npm install --quiet");
check("allow", "cargo build --quiet",     "cargo build --quiet");

// ── No minimal reporter ──
check("block", "vitest reporter dot",     "vitest run --reporter=dot",     msg("no-minimal-reporter", {cmd:"vitest"}));
check("block", "mocha reporter dot",      "mocha --reporter dot",          msg("no-minimal-reporter", {cmd:"mocha"}));
check("allow", "vitest reporter verbose", "vitest run --reporter=verbose");
check("allow", "jest reporter json",      "jest --reporter=json");
check("allow", "custom reporter",         "jest --reporter=github-actions");
check("block", "reporter dot",            "vitest --reporter=dot", msg("no-minimal-reporter", {cmd:"vitest"}));
check("block", "reporter min",            "mocha --reporter min", msg("no-minimal-reporter", {cmd:"mocha"}));

// ── No /dev/null redirects ──
check("block", "npm test 2>/dev/null",    "npm test 2>/dev/null",          msg("no-devnull-redirect"));
check("block", "vitest > /dev/null",      "vitest run > /dev/null",        msg("no-devnull-redirect"));
check("block", "jest > /dev/null 2>&1",   "jest --coverage > /dev/null 2>&1", msg("no-devnull-redirect"));
check("block", "eslint 2>&1 >/dev/null",  "eslint src/ 2>&1 > /dev/null",  msg("no-devnull-redirect"));
check("allow", "echo to file",           "echo hello > output.txt");

// ── No --loglevel suppress on tests ──
check("block", "npm test loglevel silent", "npm test --loglevel silent",   msg("no-loglevel-suppress", {cmd:"npm"}));
check("block", "npm test loglevel error",  "npm test --loglevel error",    msg("no-loglevel-suppress", {cmd:"npm"}));
check("block", "npm test loglevel=silent", "npm test --loglevel=silent",   msg("no-loglevel-suppress", {cmd:"npm"}));

// ── Wrapper recursion ──
check("block", "bash -c grep",            "bash -c 'grep foo bar'",       msg("no-grep", {cmd:"grep"}));
check("block", "sh -c find",              "sh -c 'find . -name x'",       msg("no-find", {cmd:"find"}));
check("block", "bash -lc npx",            "bash -lc 'npx eslint'",        msg("no-package-runners", {cmd:"npx"}));

// ── Backtick and $() substitution ──
check("block", "backtick find",           "`find . -name foo`",            msg("no-find", {cmd:"find"}));
check("block", "backtick grep",           "echo `grep -r secret .`",      msg("no-grep", {cmd:"grep"}));
check("block", "$() find",               "echo $(find . -name foo)",      msg("no-find", {cmd:"find"}));
check("block", "$() grep",               "result=$(grep foo bar)",        msg("no-grep", {cmd:"grep"}));

// ── env/exec prefix bypass ──
check("block", "env grep",               "env grep foo bar",              msg("no-grep", {cmd:"grep"}));
check("block", "env find",               "env find . -name x",            msg("no-find", {cmd:"find"}));
check("block", "env with vars grep",     "env FOO=bar grep -r pat .",     msg("no-grep", {cmd:"grep"}));
check("block", "exec grep",              "exec grep foo bar",             msg("no-grep", {cmd:"grep"}));
check("allow", "env alone",              "env");
check("allow", "env set var",            "env FOO=bar");

// ── Transparent prefix bypasses ──
check("block", "eval find",              'eval "find . -name foo"',       msg("no-find", {cmd:"find"}));
check("block", "command grep",           "command grep foo bar",          msg("no-grep", {cmd:"grep"}));
check("block", "time find",              "time find . -name foo",         msg("no-find", {cmd:"find"}));
check("block", "nice grep",              "nice grep foo bar",             msg("no-grep", {cmd:"grep"}));
check("block", "sudo find",              "sudo find . -name foo",         msg("no-find", {cmd:"find"}));
check("block", "nohup find",             "nohup find . -name foo",        msg("no-find", {cmd:"find"}));

// ── xargs bypass ──
check("block", "xargs find",             "echo . | xargs find",           msg("no-find", {cmd:"find"}));
check("block", "xargs grep",             "cat files.txt | xargs grep foo", msg("no-grep", {cmd:"grep"}));
check("allow", "xargs safe cmd",         "echo file.txt | xargs cat");

// ── Process substitution ──
check("block", "proc sub find",          "diff <(find . -name '*.ts') list.txt", msg("no-find", {cmd:"find"}));
check("block", "proc sub grep",          "diff <(grep foo a.txt) <(grep foo b.txt)", msg("no-grep", {cmd:"grep"}));
check("allow", "proc sub safe",          "diff <(cat a.txt) <(cat b.txt)");

// ── Herestring ──
check("block", "herestring find",        'bash <<< "find . -name foo"',   msg("no-find", {cmd:"find"}));
check("block", "herestring grep",        'sh <<< "grep foo bar"',         msg("no-grep", {cmd:"grep"}));

// ── Heredoc content not scanned ──
check("allow", "heredoc with banned word", "git commit -m \"$(cat <<'EOF'\nfind in node_modules/eslint is fine\nEOF\n)\"");
check("block", "actual find not in heredoc", "find . -name foo");

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
const TMP = path.join(__dirname, "..", ".tmp-test");
const mkTmp = (name, pkgJson, eslintConfig) => {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
  if (eslintConfig) writeFileSync(path.join(dir, "eslint.config.js"), eslintConfig);
  return dir;
};

const badLint = mkTmp("bad-lint", { scripts: { lint: "eslint src/", "lint:fix": "eslint src/ --fix" } });
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
checkCwd("block", "lint first in chain",              "npm run lint && npm run build", badLint);
checkCwd("block", "lint:fix missing config",          "npm run lint:fix", badLint);

// ── tsconfig strict check ──
const tscNoStrict = mkTmp("tsc-no-strict", { scripts: { build: "tsc" } });
writeFileSync(path.join(tscNoStrict, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2020" } }));

const tscStrict = mkTmp("tsc-strict", { scripts: { build: "tsc" } });
writeFileSync(path.join(tscStrict, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2020" } }));

const tscNoBuild = mkTmp("tsc-no-build", { scripts: { start: "node dist/index.js" } });

const nonTscBuild = mkTmp("non-tsc-build", { scripts: { build: "vite build" } });

checkCwd("block", "build without strict tsconfig",   "npm run build", tscNoStrict);
checkCwd("allow", "build with strict tsconfig",      "npm run build", tscStrict);
checkCwd("allow", "non-tsc build not checked",       "npm run build", nonTscBuild);
checkCwd("allow", "no build script",                 "npm run start", tscNoBuild);

// Cleanup
rmSync(TMP, { recursive: true, force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
