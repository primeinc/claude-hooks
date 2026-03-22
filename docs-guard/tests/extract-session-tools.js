#!/usr/bin/env node

/**
 * Extract tool_use events from Claude Code session JSONL files.
 * Outputs a simplified list of tool calls with their inputs.
 *
 * Usage: node extract-session-tools.js <session.jsonl> [--filter write,edit,context7]
 */

const fs = require("fs");
const path = require("path");

const sessionFile = process.argv[2];
const filterArg = process.argv[3] === "--filter" ? process.argv[4] : null;
const filters = filterArg ? filterArg.toLowerCase().split(",") : null;

if (!sessionFile) {
  console.error("Usage: node extract-session-tools.js <session.jsonl> [--filter tool1,tool2]");
  process.exit(1);
}

const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);

const toolCalls = [];

for (const line of lines) {
  try {
    const entry = JSON.parse(line);

    // Look for assistant messages with tool_use content blocks
    if (entry.type === "assistant" && entry.message?.content) {
      const content = Array.isArray(entry.message.content)
        ? entry.message.content
        : [entry.message.content];

      for (const block of content) {
        if (block.type === "tool_use") {
          const call = {
            tool: block.name,
            input: block.input || {},
            timestamp: entry.timestamp,
          };

          if (filters) {
            const toolLower = call.tool.toLowerCase();
            if (!filters.some(f => toolLower.includes(f))) continue;
          }

          toolCalls.push(call);
        }
      }
    }
  } catch (e) {
    // Skip unparseable lines — common for snapshot/meta entries
  }
}

// Summary
const toolCounts = {};
for (const call of toolCalls) {
  toolCounts[call.tool] = (toolCounts[call.tool] || 0) + 1;
}

console.log(`\n=== Session: ${path.basename(sessionFile)} ===`);
console.log(`Total tool calls: ${toolCalls.length}`);
console.log(`\nTool usage breakdown:`);
for (const [tool, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tool}: ${count}`);
}

// Output the calls as JSON — write next to this script, not in the session dir
const sessionName = path.basename(sessionFile, ".jsonl");
const outputDir = path.join(__dirname, "fixtures");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `${sessionName}-tools.json`);
fs.writeFileSync(outputFile, JSON.stringify(toolCalls, null, 2));
console.log(`\nExtracted ${toolCalls.length} tool calls to: ${outputFile}`);
