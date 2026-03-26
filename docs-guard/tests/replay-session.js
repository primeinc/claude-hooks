#!/usr/bin/env node

/**
 * Replay a session's tool calls through the docs-guard pipeline.
 * Simulates what would have happened if the gate was active.
 *
 * Usage:
 *   node replay-session.js <session-tools.json>
 *   node tests/extract-session-tools.js <session.jsonl>  # to generate input
 */

const fs = require("fs");
const path = require("path");
const { clearState, dumpState } = require("../src/state");
const { track, SIMPLE_EXTRACTORS } = require("../src/tracker");
const { check, PARSEABLE } = require("../src/gate");

const toolsFile = process.argv[2];
if (!toolsFile) {
  console.error("Usage: node replay-session.js <session-tools.json>");
  process.exit(1);
}

const toolCalls = JSON.parse(fs.readFileSync(toolsFile, "utf8"));

clearState();

let totalWrites = 0;
let blocked = 0;
let allowed = 0;
let skipped = 0;
let docLookups = 0;
const blockedDetails = [];

for (const call of toolCalls) {
  const { tool, input } = call;

  // Track doc lookups using the real tracker module
  if (SIMPLE_EXTRACTORS[tool]) {
    const recorded = track(tool, input);
    if (recorded) docLookups++;
    // Don't skip Read — it might also be a Write/Edit (it won't, but don't filter)
    if (tool !== "Read") continue;
  }

  // Gate check on Write/Edit using the real gate module
  if (tool === "Write" || tool === "Edit") {
    totalWrites++;
    const result = check(tool, input);

    if (result.ok) {
      const filePath = input.file_path || "";
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      if (filePath && PARSEABLE.has(ext)) {
        allowed++;
      } else {
        skipped++;
      }
    } else {
      blocked++;
      blockedDetails.push({
        tool,
        file: input.file_path,
        uncovered: result.uncovered,
        timestamp: call.timestamp,
      });
    }
  }
}

// --- Report ---

console.log(`\n=== Replay: ${path.basename(toolsFile)} ===\n`);
console.log(`Total tool calls in session: ${toolCalls.length}`);
console.log(`Doc lookups recorded: ${docLookups}`);
console.log(`Write/Edit calls: ${totalWrites}`);
console.log(`  Allowed (library covered or no libs): ${allowed}`);
console.log(`  Skipped (non-JS/TS files): ${skipped}`);
console.log(`  BLOCKED (uncovered library): ${blocked}`);

if (blockedDetails.length > 0) {
  console.log(`\n--- Blocked writes ---\n`);
  for (const b of blockedDetails) {
    const libs = b.uncovered.map(u => {
      const feats = u.features.length > 0 ? ` [${u.features.join(", ")}]` : "";
      return `${u.name}${feats}`;
    }).join(", ");
    console.log(`  ${b.tool} ${b.file}`);
    console.log(`    Uncovered: ${libs}`);
  }
}

const finalState = dumpState();
if (finalState.lookups.length > 0) {
  console.log(`\n--- Lookup log ---\n`);
  for (const l of finalState.lookups) {
    console.log(`  [${l.source}] ${l.library || "(no lib)"}: ${l.query}`);
  }
}

console.log("");
