#!/usr/bin/env node
"use strict";

/**
 * Test harness for the frustration detector.
 *
 * Tests the classify() function directly — no subprocess, no bash dependency.
 * Also validates hook output format for each category.
 *
 * Usage:
 *   node test-frustration.js              # run all tests
 *   node test-frustration.js --verbose    # show each case
 *   node test-frustration.js --benchmark  # save timestamped results to tests/results/
 */

const { readFileSync, writeFileSync, mkdirSync } = require("fs");
const path = require("path");
const { classify, hookOutput, MESSAGES } = require("./detect.js");

const FIXTURES = path.join(__dirname, "..", "tests", "fixtures", "test-cases.json");
const RESULTS_DIR = path.join(__dirname, "..", "tests", "results");

const cases = JSON.parse(readFileSync(FIXTURES, "utf8"));
const verbose = process.argv.includes("--verbose");
const benchmark = process.argv.includes("--benchmark");

let pass = 0;
let fail = 0;
const results = [];

// ── Test cases ──────────────────────────────────────────────────────

for (const tc of cases) {
  const actual = classify(tc.input) || "NONE";
  const expected = tc.expected_class;
  const ok = actual === expected;

  if (ok) {
    pass++;
    if (verbose) {
      console.log(`  ok  ${tc.id}: ${expected}`);
    }
  } else {
    fail++;
    console.log(`FAIL: ${tc.id} (expected=${expected}, got=${actual})`);
    console.log(`      input: "${tc.input.slice(0, 80)}${tc.input.length > 80 ? "..." : ""}"`);
    console.log(`      notes: ${tc.notes}`);
  }

  results.push({
    id: tc.id,
    input: tc.input,
    expected,
    actual,
    status: ok ? "PASS" : "FAIL",
    notes: tc.notes,
  });
}

// ── Hook output format tests ────────────────────────────────────────

for (const category of ["HIGH", "CIRCULAR_RETRY", "SCOPE_DRIFT", "MILD"]) {
  const output = hookOutput(category);

  if (!output || output.continue !== true) {
    fail++;
    console.log(`FAIL: hookOutput(${category}) missing continue:true`);
  } else if (!output.systemMessage || !output.systemMessage.includes(category.replace("_", " "))) {
    fail++;
    console.log(`FAIL: hookOutput(${category}) systemMessage missing category label`);
  } else {
    pass++;
    if (verbose) console.log(`  ok  hookOutput(${category}): valid format`);
  }
}

// Verify NONE produces no output
const noneOutput = hookOutput("NONE");
if (noneOutput !== null) {
  fail++;
  console.log(`FAIL: hookOutput(NONE) should return null`);
} else {
  pass++;
  if (verbose) console.log(`  ok  hookOutput(NONE): returns null`);
}

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\nResults: ${pass} passed, ${fail} failed`);

// Per-category breakdown
const categories = ["NONE", "MILD", "HIGH", "CIRCULAR_RETRY", "SCOPE_DRIFT"];
if (verbose || fail > 0) {
  console.log("");
  for (const cat of categories) {
    const catCases = results.filter((r) => r.expected === cat);
    const catPass = catCases.filter((r) => r.status === "PASS").length;
    if (catCases.length > 0) {
      const pct = Math.round((catPass * 100) / catCases.length);
      console.log(`  ${cat.padEnd(16)} ${catPass}/${catCases.length} (${pct}%)`);
    }
  }
}

// ── Benchmark output ────────────────────────────────────────────────

if (benchmark) {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const summary = {
    timestamp,
    total: results.length,
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    accuracy_pct: Math.round((pass * 100) / (pass + fail) * 10) / 10,
    by_category: {},
    results,
  };

  for (const cat of categories) {
    const catCases = results.filter((r) => r.expected === cat);
    const catPass = catCases.filter((r) => r.status === "PASS").length;
    if (catCases.length > 0) {
      summary.by_category[cat] = {
        total: catCases.length,
        pass: catPass,
        accuracy_pct: Math.round((catPass * 100) / catCases.length),
      };
    }
  }

  const outPath = path.join(RESULTS_DIR, `benchmark_${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nSaved: ${outPath}`);
}

process.exit(fail > 0 ? 1 : 0);
