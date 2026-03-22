#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const sessionFile = process.argv[2];
if (!sessionFile) {
  console.error("Usage: node correlate-session.js <session.jsonl>");
  process.exit(1);
}

const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);

// Find where docs-guard first appears
let start = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("docs-guard") || lines[i].includes("DOCS FIRST")) {
    start = i;
    break;
  }
}

console.log(`\nScanning from line ${start} to ${lines.length}\n`);
console.log("=".repeat(80));

for (let i = start; i < lines.length; i++) {
  try {
    const entry = JSON.parse(lines[i]);

    if (entry.type === "assistant" && entry.message?.content) {
      const blocks = Array.isArray(entry.message.content) ? entry.message.content : [entry.message.content];
      for (const b of blocks) {
        // Context7 lookups
        if (b.type === "tool_use" && b.name && b.name.includes("context7")) {
          console.log(`\nLOOKUP [${b.name}]`);
          if (b.input?.libraryName) console.log(`  libraryName: ${b.input.libraryName}`);
          if (b.input?.libraryId) console.log(`  libraryId: ${b.input.libraryId}`);
          if (b.input?.query) console.log(`  query: ${b.input.query}`);
        }

        // Write/Edit attempts
        if (b.type === "tool_use" && (b.name === "Edit" || b.name === "Write")) {
          const fp = b.input?.file_path || "";
          const fname = fp.split(/[/\\]/).pop();
          console.log(`\n${b.name} -> ${fname}`);
        }
      }
    }

    // Hook blocks - check all content arrays
    const msgContent = entry.message?.content;
    if (Array.isArray(msgContent)) {
      for (const c of msgContent) {
        const txt = typeof c === "string" ? c : (c?.text || "");
        if (txt.includes("DOCS FIRST")) {
          const libLines = txt.split("\n").filter(l => l.trim().startsWith("- "));
          console.log("  >>> BLOCKED:");
          for (const l of libLines) {
            if (!l.includes("context7") && !l.includes("learndocs") && !l.includes("WebFetch") && !l.includes("Read files")) {
              console.log("  " + l.trim());
            }
          }
        }
      }
    }

    // Also check system/tool_result entries for hook errors
    if (entry.content && typeof entry.content === "string" && entry.content.includes("DOCS FIRST")) {
      const libLines = entry.content.split("\n").filter(l => l.trim().startsWith("- "));
      console.log("  >>> BLOCKED:");
      for (const l of libLines) {
        if (!l.includes("context7") && !l.includes("learndocs") && !l.includes("WebFetch") && !l.includes("Read files")) {
          console.log("  " + l.trim());
        }
      }
    }

  } catch {}
}

console.log("\n" + "=".repeat(80));
