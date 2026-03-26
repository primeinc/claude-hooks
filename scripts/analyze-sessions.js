#!/usr/bin/env node
"use strict";

/**
 * Streaming census analyzer for Claude Code session data.
 *
 * Processes all session JSONL files for a project + matching hook logs.
 * Groups everything by date. Never loads full files into memory.
 *
 * Usage:
 *   node scripts/analyze-sessions.js                                    # default: closing-cast
 *   node scripts/analyze-sessions.js --project C--Users-will-dev-foo    # other project
 *   node scripts/analyze-sessions.js --log /path/to/claude-hooks-X.log  # specific log file
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");
const crypto = require("crypto");

// ── Config ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PROJECT = getArg("--project", "C--Users-will-dev-closing-cast");
const SESSION_DIR = path.join(os.homedir(), ".claude", "projects", PROJECT);
const LOG_FILE = getArg("--log", null);

// ── Date grouping helpers ────────────────────────────────────────────

function dateKey(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function friendlyDate(iso) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date(iso);
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// ── Stats accumulators ───────────────────────────────────────────────

const daily = {}; // dateKey → { sessions, toolCalls, toolBreakdown, context7, blocks, frustrations, ... }

function ensureDay(dk) {
  if (!daily[dk]) {
    daily[dk] = {
      sessions: 0,
      toolCalls: 0,
      toolBreakdown: {},
      context7Resolve: 0,
      context7Query: 0,
      context7Libraries: {},
      resolveToQueryDelays: [],
      incompleteFlows: {},
    };
  }
  return daily[dk];
}

// Totals (session JSONL only — tool calls and context7 flows)
const totals = {
  sessions: 0,
  toolCalls: 0,
  context7Resolve: 0,
  context7Query: 0,
  resolveToQueryDelays: [],
  incompleteFlows: {},
};

// ── Session JSONL streaming parser ───────────────────────────────────

async function processSession(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let sessionDate = null;
  let day = null;
  const pendingResolves = {}; // libraryName → timestamp

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract timestamp for date grouping
    const ts = entry.timestamp || entry.message?.timestamp;
    if (ts && !sessionDate) {
      sessionDate = dateKey(ts);
      day = ensureDay(sessionDate);
      day.sessions++;
      totals.sessions++;
    }
    if (!day) {
      // Try to get date from any field
      const anyTs = ts || entry.createdAt || entry.startedAt;
      if (anyTs) {
        sessionDate = dateKey(anyTs);
        day = ensureDay(sessionDate);
        day.sessions++;
        totals.sessions++;
      } else {
        continue;
      }
    }

    // Extract tool_use events from assistant messages
    if (entry.type === "assistant" && entry.message?.content) {
      const content = Array.isArray(entry.message.content)
        ? entry.message.content
        : [entry.message.content];

      for (const block of content) {
        if (block.type !== "tool_use") continue;

        day.toolCalls++;
        totals.toolCalls++;
        const tool = block.name || "unknown";
        day.toolBreakdown[tool] = (day.toolBreakdown[tool] || 0) + 1;

        // Context7 resolve
        if (tool === "mcp__context7__resolve-library-id") {
          day.context7Resolve++;
          totals.context7Resolve++;
          const libName = block.input?.libraryName || "";
          if (libName) {
            day.context7Libraries[libName] = (day.context7Libraries[libName] || 0) + 1;
            pendingResolves[libName] = ts;
          }
        }

        // Context7 query-docs
        if (tool === "mcp__context7__query-docs") {
          day.context7Query++;
          totals.context7Query++;
          const libId = block.input?.libraryId || "";
          // Try to match to a pending resolve for flow timing
          const segments = libId.split("/").filter(Boolean).filter(s => !/^v?\d/.test(s));
          const lastSeg = segments.pop() || "";
          for (const [name, resolveTs] of Object.entries(pendingResolves)) {
            if (lastSeg.toLowerCase().includes(name.toLowerCase()) ||
                name.toLowerCase().includes(lastSeg.toLowerCase())) {
              if (resolveTs && ts) {
                const delay = new Date(ts).getTime() - new Date(resolveTs).getTime();
                if (delay > 0 && delay < 300000) { // sanity: < 5 min
                  day.resolveToQueryDelays.push(delay);
                  totals.resolveToQueryDelays.push(delay);
                }
              }
              delete pendingResolves[name];
              break;
            }
          }
        }

      }
    }

    // Block/frustration detection removed — use hook logs as authoritative source
  }

  // Record incomplete flows (resolves without matching query-docs)
  for (const name of Object.keys(pendingResolves)) {
    if (day) {
      day.incompleteFlows[name] = (day.incompleteFlows[name] || 0) + 1;
      totals.incompleteFlows[name] = (totals.incompleteFlows[name] || 0) + 1;
    }
  }
}

// ── Hook log parser ──────────────────────────────────────────────────

const logStats = {
  bySubsystem: {},  // sub → { total, blocked, allowed, fuzzy, deterministic }
  blockedCommands: {},
  blockedLibraries: {},
  frustrations: { HIGH: 0, CIRCULAR_RETRY: 0, SCOPE_DRIFT: 0, MILD: 0 },
};

function ensureLogSub(sub) {
  if (!logStats.bySubsystem[sub]) {
    logStats.bySubsystem[sub] = { total: 0, blocked: 0, allowed: 0, fuzzy: 0, deterministic: 0 };
  }
  return logStats.bySubsystem[sub];
}

async function processLogFile(logPath) {
  if (!fs.existsSync(logPath)) return;

  const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const sub = entry.sub || "unknown";
    const s = ensureLogSub(sub);
    s.total++;

    // Bash guards log "Blocked" / "Blocked (standards)"; docs-guard logs "Blocking Write on ..." / "Blocking Edit on ..."
    if (entry.msg === "Blocked" || entry.msg === "Blocked (standards)" || (entry.msg && entry.msg.startsWith("Blocking "))) {
      s.blocked++;
      const reason = entry.data?.reason || "";
      const cmdMatch = reason.match(/\b(find|grep|egrep|fgrep|head|tail|less|more|npx|bunx|pnpx)\b/i);
      if (cmdMatch) {
        const c = cmdMatch[1].toLowerCase();
        logStats.blockedCommands[c] = (logStats.blockedCommands[c] || 0) + 1;
      }
    }

    if (entry.msg === "Allowed" || entry.msg === "  All libraries covered — allowing") s.allowed++;

    if (entry.msg === "Fuzzy match used (no deterministic mapping)") {
      s.fuzzy++;
    }
    if (entry.msg && entry.msg.includes("hasLookup") && entry.msg.includes("FOUND via exact")) {
      s.deterministic++;
    }
    if (entry.msg && entry.msg.includes("hasLookup") && entry.msg.includes("FOUND via mapped")) {
      s.deterministic++;
    }

    // Frustration from logs
    if (entry.sub === "frustration-detector" && entry.msg === "Detected") {
      const cat = entry.data?.category;
      if (cat && logStats.frustrations[cat] !== undefined) {
        logStats.frustrations[cat]++;
      }
    }

    // Blocked libraries from gate
    if (entry.msg && entry.msg.startsWith("Blocking")) {
      const libs = entry.data?.uncovered || [];
      for (const lib of libs) {
        logStats.blockedLibraries[lib] = (logStats.blockedLibraries[lib] || 0) + 1;
      }
    }
  }
}

// ── Percentile helper ────────────────────────────────────────────────

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Report ───────────────────────────────────────────────────────────

function printReport() {
  const dates = Object.keys(daily).sort();
  console.log("\n" + "=".repeat(80));
  console.log("  SESSION PERFORMANCE REPORT");
  console.log("  Project: " + PROJECT);
  console.log("  Sessions: " + totals.sessions + " | Date range: " + (dates[0] || "?") + " to " + (dates[dates.length - 1] || "?"));
  console.log("  Data sources: session JSONL (tool calls, timing) + hook logs (blocks, mapping)");
  console.log("=".repeat(80));

  // Daily summary (session JSONL data only)
  console.log("\n--- Daily Summary (from session JSONL) ---\n");
  console.log(
    "Date".padEnd(12) +
    "Sessions".padStart(10) +
    "ToolCalls".padStart(11) +
    "C7Resolve".padStart(11) +
    "C7Query".padStart(9)
  );
  console.log("-".repeat(53));

  for (const dk of dates) {
    const d = daily[dk];
    console.log(
      friendlyDate(dk).padEnd(12) +
      String(d.sessions).padStart(10) +
      String(d.toolCalls).padStart(11) +
      String(d.context7Resolve).padStart(11) +
      String(d.context7Query).padStart(9)
    );
  }

  // Context7 flow
  console.log("\n--- Context7 Flow ---\n");
  const queryResolveRatio = totals.context7Resolve > 0
    ? ((totals.context7Query / totals.context7Resolve) * 100).toFixed(1)
    : "N/A";
  const unpairedResolves = Object.keys(totals.incompleteFlows).length;
  const unpairedQueries = Math.max(0, totals.context7Query - totals.context7Resolve);
  console.log(`Resolve calls: ${totals.context7Resolve} | Query-docs calls: ${totals.context7Query} | Query/resolve ratio: ${queryResolveRatio}%`);
  console.log(`Unpaired resolves (no query-docs): ${unpairedResolves} | Unpaired query-docs (no resolve): ${unpairedQueries}`);

  if (totals.resolveToQueryDelays.length > 0) {
    console.log(`Resolve→query-docs delay: avg ${formatMs(avg(totals.resolveToQueryDelays))} | p50 ${formatMs(percentile(totals.resolveToQueryDelays, 0.5))} | p95 ${formatMs(percentile(totals.resolveToQueryDelays, 0.95))}`);
  }

  const incKeys = Object.keys(totals.incompleteFlows);
  if (incKeys.length > 0) {
    console.log(`Incomplete flows (resolve without query-docs): ${incKeys.slice(0, 10).map(k => `${k}(${totals.incompleteFlows[k]})`).join(", ")}`);
  }

  // Tool breakdown (top 15)
  console.log("\n--- Tool Usage (top 15) ---\n");
  const allTools = {};
  for (const dk of dates) {
    for (const [t, c] of Object.entries(daily[dk].toolBreakdown)) {
      allTools[t] = (allTools[t] || 0) + c;
    }
  }
  const topTools = Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [t, c] of topTools) {
    const pct = ((c / totals.toolCalls) * 100).toFixed(1);
    console.log(`  ${t.padEnd(50)} ${String(c).padStart(6)} (${pct}%)`);
  }

  // Hook log stats (authoritative source for blocks, frustrations, mapping health)
  if (Object.keys(logStats.bySubsystem).length > 0) {
    console.log("\n--- Hook Stats (from structured logs — authoritative) ---\n");
    for (const [sub, s] of Object.entries(logStats.bySubsystem)) {
      const blockRate = s.total > 0 ? ((s.blocked / s.total) * 100).toFixed(1) : "0";
      const matchInfo = s.fuzzy + s.deterministic > 0
        ? ` | det:${s.deterministic} fuzzy:${s.fuzzy}`
        : "";
      console.log(`  ${sub.padEnd(25)} total:${String(s.total).padStart(5)} blocked:${String(s.blocked).padStart(4)} allowed:${String(s.allowed).padStart(4)} (${blockRate}% block)${matchInfo}`);
    }

    const logTopCmds = Object.entries(logStats.blockedCommands).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (logTopCmds.length > 0) {
      console.log(`\n  Log blocked commands: ${logTopCmds.map(([k, v]) => `${k}(${v})`).join(", ")}`);
    }
    const logTopLibs = Object.entries(logStats.blockedLibraries).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (logTopLibs.length > 0) {
      console.log(`  Log blocked libraries: ${logTopLibs.map(([k, v]) => `${k}(${v})`).join(", ")}`);
    }

    // Mapping health
    const dg = logStats.bySubsystem["docs-guard"];
    if (dg && (dg.fuzzy + dg.deterministic) > 0) {
      const totalMatches = dg.fuzzy + dg.deterministic;
      console.log(`\n  Mapping health: ${dg.deterministic}/${totalMatches} deterministic (${((dg.deterministic / totalMatches) * 100).toFixed(1)}%) | ${dg.fuzzy}/${totalMatches} fuzzy (${((dg.fuzzy / totalMatches) * 100).toFixed(1)}%)`);
    }
  }

  console.log("\n" + "=".repeat(80));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // Validate session directory
  if (!fs.existsSync(SESSION_DIR)) {
    console.error(`Session directory not found: ${SESSION_DIR}`);
    process.exit(1);
  }

  // Find all session JSONL files
  const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith(".jsonl")).sort();
  console.log(`Processing ${files.length} sessions from ${SESSION_DIR}...`);

  // Stream each session
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (i % 10 === 0 && i > 0) process.stderr.write(`  ${i}/${files.length}...\n`);
    await processSession(path.join(SESSION_DIR, f));
  }
  console.log(`  ${files.length}/${files.length} done.`);

  // Process hook log files
  if (LOG_FILE) {
    console.log(`Processing log: ${LOG_FILE}`);
    await processLogFile(LOG_FILE);
    if (fs.existsSync(LOG_FILE + ".prev")) {
      await processLogFile(LOG_FILE + ".prev");
    }
  } else {
    // Derive CWD from project dir name and compute hash to find matching log
    // Project dir name format: C--Users-will-dev-closing-cast → C:\Users\will\dev\closing-cast
    const cwdFromProject = PROJECT.replace(/--/g, ":\\").replace(/-/g, "\\").replace(/:\\/g, ":\\");
    const cwdHash = crypto.createHash("md5").update(cwdFromProject).digest("hex").slice(0, 12);
    const logPath = path.join(os.tmpdir(), `claude-hooks-${cwdHash}.log`);

    if (fs.existsSync(logPath)) {
      console.log(`Processing log: ${logPath} (hash: ${cwdHash})`);
      await processLogFile(logPath);
      if (fs.existsSync(logPath + ".prev")) {
        await processLogFile(logPath + ".prev");
      }
    } else {
      console.log(`No hook log found for hash ${cwdHash} (derived CWD: ${cwdFromProject})`);
      console.log(`Use --log /path/to/claude-hooks-HASH.log to specify manually`);
    }
  }

  printReport();
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
