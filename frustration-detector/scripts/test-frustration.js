#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const { readFileSync } = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "quick-detect.sh");
const FIXTURES = path.join(__dirname, "..", "tests", "fixtures", "test-cases.json");

const cases = JSON.parse(readFileSync(FIXTURES, "utf8"));

let pass = 0;
let fail = 0;

function classify(output) {
  if (!output.trim()) return "NONE";
  try {
    const msg = JSON.parse(output).systemMessage || "";
    if (msg.includes("HIGH FRUSTRATION")) return "HIGH";
    if (msg.includes("CIRCULAR RETRY")) return "CIRCULAR_RETRY";
    if (msg.includes("SCOPE DRIFT")) return "SCOPE_DRIFT";
    if (msg.includes("MILD CORRECTION")) return "MILD";
  } catch {}
  return "UNKNOWN";
}

for (const tc of cases) {
  const input = JSON.stringify({ prompt: tc.input });
  let stdout = "";
  try {
    stdout = execSync(`bash "${SCRIPT}"`, {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    }).toString();
  } catch (e) {
    stdout = "";
  }

  const actual = classify(stdout);
  const expected = tc.expected_class;

  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${tc.id} (expected=${expected}, got=${actual})`);
    console.log(`      input: "${tc.input.slice(0, 80)}${tc.input.length > 80 ? "..." : ""}"`);
    console.log(`      notes: ${tc.notes}`);
  }
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
