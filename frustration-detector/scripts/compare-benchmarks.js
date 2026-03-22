#!/usr/bin/env node
"use strict";

/**
 * Compare benchmark results across runs.
 *
 * Reads all benchmark_*.json files from tests/results/ and shows
 * accuracy trends over time and per-category deltas.
 *
 * Usage: node compare-benchmarks.js
 */

const { readdirSync, readFileSync } = require("fs");
const path = require("path");

const RESULTS_DIR = path.join(__dirname, "..", "tests", "results");

let files;
try {
  files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith("benchmark_") && f.endsWith(".json"))
    .sort();
} catch {
  console.log("No results directory found. Run: npm run benchmark");
  process.exit(0);
}

if (files.length === 0) {
  console.log("No benchmark results found. Run: npm run benchmark");
  process.exit(0);
}

// ── Timeline ────────────────────────────────────────────────────────

console.log("=== Benchmark History ===\n");
console.log(
  "Timestamp".padEnd(18) +
  "Total".padStart(8) +
  "Pass".padStart(8) +
  "Fail".padStart(8) +
  "Accuracy".padStart(10)
);
console.log("-".repeat(52));

const runs = files.map((f) => {
  const data = JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf8"));
  console.log(
    (data.timestamp || f).padEnd(18) +
    String(data.total).padStart(8) +
    String(data.pass).padStart(8) +
    String(data.fail).padStart(8) +
    (data.accuracy_pct + "%").padStart(10)
  );
  return data;
});

// ── Category trends ─────────────────────────────────────────────────

if (runs.length >= 2) {
  const first = runs[0];
  const latest = runs[runs.length - 1];

  console.log("\n=== Category Trends (first → latest) ===\n");

  const categories = ["NONE", "MILD", "HIGH", "CIRCULAR_RETRY", "SCOPE_DRIFT"];
  for (const cat of categories) {
    const fCat = first.by_category?.[cat];
    const lCat = latest.by_category?.[cat];
    if (fCat && lCat) {
      const delta = lCat.accuracy_pct - fCat.accuracy_pct;
      const arrow = delta > 0 ? "+" : delta === 0 ? "=" : "";
      console.log(
        `  ${cat.padEnd(18)} ${fCat.accuracy_pct}% → ${lCat.accuracy_pct}% (${arrow}${delta}%)`
      );
    }
  }
} else {
  console.log("\nNeed at least 2 benchmark runs to compare trends.");
}
