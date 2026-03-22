#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const { classify } = require("../../frustration-detector/scripts/detect.js");
const path = require("path");

const SCRIPT = path.join(__dirname, "validate-bash.js");

function testGuard(cmd, expect) {
  const input = JSON.stringify({ tool_input: { command: cmd } });
  let stdout = "";
  try {
    stdout = execSync(`node "${SCRIPT}"`, {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    }).toString();
  } catch {}
  return stdout.trim() ? "block" : "allow";
}

const guardCases = [
  ["npm test 2>/dev/null", "block", "stderr devnull"],
  ["vitest run > /dev/null", "block", "stdout devnull"],
  ["npm test --loglevel=silent", "block", "loglevel=silent"],
  ["npm test | tee /dev/null", "block", "tee devnull"],
  ["vitest run --reporter=dot", "block", "reporter dot"],
  ['bash -c "npm test --silent"', "block", "wrapper silent"],
  ["`find . -name foo`", "block", "backtick"],
  ["echo $(find . -name foo)", "block", "dollar-paren"],
  ["env grep foo bar", "block", "env prefix"],
  ["exec grep foo bar", "block", "exec prefix"],
  ["echo . | xargs find", "block", "xargs"],
  ["node node_modules/eslint/bin/eslint.js src/", "block", "node_modules path"],
  ["npm run test:coverage > /tmp/cov.txt 2>&1", "block", "test redirect"],
  ['echo "use rg.exe" && grep -r secret .', "block", "exempt_when raw"],
  ['eval "find . -name foo"', "block", "eval"],
  ["sudo find . -name foo", "block", "sudo"],
  ["diff <(find . -name x) list", "block", "proc sub"],
  ['bash <<< "find . -name foo"', "block", "herestring"],
  ["vitest run --reporter=verbose", "allow", "verbose reporter"],
  ["npm install --quiet", "allow", "install quiet"],
  ["cargo build --quiet", "allow", "cargo build quiet"],
  ["git status", "allow", "git status"],
  ["jest --reporter=github-actions", "allow", "custom reporter"],
];

let gOk = 0, gFail = 0;
for (const [cmd, expect, desc] of guardCases) {
  const actual = testGuard(cmd, expect);
  if (actual === expect) {
    gOk++;
  } else {
    gFail++;
    console.log(`GUARD FAIL: ${desc} exp=${expect} got=${actual}  ${cmd}`);
  }
}

const frusCases = [
  // Casual — should NOT trigger
  ["oh shit I forgot", null, "casual"],
  ["how can you work around all that shit", null, "filler"],
  ["kick ass implementation", null, "compliment"],
  ["damn that was fast", null, "positive"],
  ["can you fix the shit in the build", null, "question"],
  ["damn that config is crappy", null, "casual pair"],
  ["pain in the ass to configure", null, "idiom"],
  ["GET THE DOCS", null, "caps instruction 3 words"],
  ["STOP CONDITION NOT MET", null, "caps instruction 4 words"],
  ["fix the API endpoint", null, "clean instruction"],
  // Directed — should trigger HIGH
  ["your code is shit", "HIGH", "directed"],
  ["you fucking broke it", "HIGH", "you+fuck"],
  ["WHAT THE FUCK IS WRONG WITH YOU", "HIGH", "caps rage"],
  ["this is bullshit", "HIGH", "exclamatory"],
  ["holy shit you broke everything", "HIGH", "holy shit"],
  ["STOP BLOCKING MY COMMANDS YOU ABSOLUTE WASTE", "HIGH", "caps rage 7 words"],
  ["you are so full of shit", "HIGH", "you are + shit"],
  ["CHECK THE FUCKING GIT LOGS YOU FUCK", "HIGH", "angry instruction"],
  // Other categories
  ["same error again", "CIRCULAR_RETRY", "circular"],
  ["this doesnt work", "CIRCULAR_RETRY", "doesnt work"],
  ["not what I asked for", "SCOPE_DRIFT", "scope"],
  ["wrong file check the docs", "MILD", "mild"],
  ["your wrong get the docs", "MILD", "your wrong"],
];

let fOk = 0, fFail = 0;
for (const [text, expect, desc] of frusCases) {
  const actual = classify(text);
  if (actual === expect) {
    fOk++;
  } else {
    fFail++;
    console.log(`FRUST FAIL: ${desc} exp=${expect} got=${actual}  ${text}`);
  }
}

console.log(`\nGuards: ${gOk}/${guardCases.length}  Frustration: ${fOk}/${frusCases.length}`);
process.exit(gFail + fFail > 0 ? 1 : 0);
