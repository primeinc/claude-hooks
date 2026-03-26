# Metrics Research: First-Party Performance Measurement

## Hook Contract Reference (from first-party docs)

**PreToolUse output** (documented):
```json
{
  "hookSpecificOutput": { "permissionDecision": "allow|deny|ask" },
  "systemMessage": "Reason for deny — fed to Claude"
}
```

**PostToolUse input fields** (documented):
`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_result`

Note: `tool_result` is the documented field name. Code now reads `tool_result` with `tool_response` fallback for older builds.

Source: `/anthropics/claude-code` — `plugins/plugin-dev/skills/hook-development/SKILL.md`

## What We Can Measure Today vs. What Requires Changes

### Available Now (zero code changes)

| Source | What it measures | Precision | How to access |
|--------|-----------------|-----------|---------------|
| **Session JSONL** (`~/.claude/projects/{project}/*.jsonl`) | Tool call sequences, timestamps between events, context7 flow timing, block/recovery patterns | Indirect — event gaps show workflow delay, not execution time | `scripts/analyze-sessions.js` streams all sessions |
| **Hook structured logs** (`{tmpdir}/claude-hooks-{hash}.log`) | Block/allow decisions, fuzzy vs deterministic match rate, frustration detections, blocked commands/libraries | Good for outcomes, no latency data | Parse JSON lines, group by `sub`/`level`/`msg` |
| **Docs-guard state files** (`{tmpdir}/docs-guard-{hash}.json`) | Active lookups, mappings, resolve attempts at snapshot time | Exact state at last write | Read JSON directly |

**Current baseline from closing-cast (91 sessions, Mar 18-23):**
- Resolve→query-docs median delay: 6.9s, p95: 30.2s
- Mapping health: 30% deterministic, 70% fuzzy (pre-fix; expect improvement post-fix)
- Bash guard block rate: 19.6% (find: 200, grep: 184)
- Top blocked libraries: zod(52), react(40), express(36)
- Context7 is 2.6% of all tool calls (179 resolve + 261 query-docs out of 16,996 total)

### Available After Minimal Instrumentation

| Change | What it enables | Effort | Files |
|--------|----------------|--------|-------|
| **`timer()` in `lib/logger.js`** | `duration_ms` field on every hook log entry | 10 lines | `lib/logger.js` |
| **Instrument hook entry points** | Per-hook execution time: stdin parse → decision → exit | ~5 lines per file | `validate-bash.js`, `detect.js`, `gate.js`, `tracker.js`, `session-clear.js` |
| **Session summary counters** | Per-session aggregates logged at next SessionStart | ~40 lines | `session-clear.js` + counter file in tmpdir |

**Implementation pattern:**
```javascript
// lib/logger.js — add export
function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

// Each hook entry point — add at stdin parse
const { timer } = require("../../lib/logger");
const elapsed = timer();

// Final log before exit
bashLog.debug("Allowed", { duration_ms: elapsed() });
```

**Expected cost:** ~30 minutes implementation, zero runtime overhead (Date.now() is <1μs).

**What this unlocks:**
- p50/p95/p99 hook execution latency per subsystem
- AST parsing cost for docs-guard gate (suspected bottleneck at ~37ms from log timestamp analysis)
- Whether Node.js subprocess startup dominates (gap between hook invocations is ~100-300ms in test runs; the hook itself takes 1-2ms)

### Requires External Infrastructure

| Source | What it measures | Available? | Setup cost | Blind spots |
|--------|-----------------|-----------|------------|-------------|
| **Context7 MCP server telemetry** | Server-side resolve/query latency, cache hit rates, error rates | Unknown — context7 is a third-party MCP server | Would need to contact context7 maintainers or inspect MCP protocol for timing headers | Only covers context7, not other MCP servers |
| **Claude Code hook framework timing** | Total hook overhead including subprocess spawn, stdin serialization, stdout parsing | Not exposed in current hook contract | Would require Claude Code CLI changes | Platform-specific (Node.js startup time varies by OS) |
| **Claude Code session telemetry** | Token usage, model latency, conversation turn timing | Partially in session JSONL (usage stats, cache metrics visible in some entries) | Already available but undocumented format | Format may change between Claude Code versions |

## Recommended Metrics Architecture

### Tier 1: Instrument Now (low effort, high value)

1. **Add `timer()` + `duration_ms` to all hooks** — direct execution latency
2. **Add session summary counters** — per-session block/allow/frustration totals
3. **Run `analyze-sessions.js` weekly** — track trends in context7 flow completion, block rates, mapping health

### Tier 2: Build When Needed (medium effort)

4. **Log analysis script** (`scripts/analyze-logs.js`) — reads instrumented logs, computes p50/p95/p99 `duration_ms` per subsystem, outputs trends like `compare-benchmarks.js`
5. **Pre/post comparison** — run `analyze-sessions.js` before and after code changes to measure impact (e.g., context7 regex fix → mapping health improvement)

### Tier 3: Investigate Later (high effort, uncertain value)

6. **MCP protocol timing** — check if MCP tool responses include any timing metadata (request ID, server-side duration)
7. **Claude Code native metrics** — monitor for official hooks/plugin performance APIs in future Claude Code releases
8. **Subprocess startup profiling** — measure Node.js cold start overhead separately from hook logic (relevant if hooks need to be faster than 100ms)

## Key Insight: The Real Bottleneck

From the session data, the dominant cost is **not hook execution** (1-37ms) but **context7 round-trip time** (median 6.9s, p95 30.2s) and **block recovery workflow** (time lost when docs-guard blocks a Write and Claude has to look up docs before retrying). These are workflow-level delays, not code-level latency.

The highest-ROI improvements are:
1. **Fix the mapping pipeline** (Track 1) — eliminate 70% fuzzy fallback, reduce false blocks
2. **Reduce unnecessary blocks for well-known libraries** — consider a whitelist for react, express, zod etc. that doesn't require lookup
3. **Cache resolve mappings across sessions** — if react always maps to the same context7 IDs, don't re-resolve every session

Hook execution speed is not a bottleneck. Context7 network latency and unnecessary block-then-recover cycles are.

## Metric Definitions

For consistency across all analysis tooling:

| Metric | Definition | Source |
|--------|-----------|--------|
| **Workflow delay** | Time between two session JSONL events (includes model thinking, network, user wait) | Session JSONL timestamps |
| **Hook execution time** | Time from stdin parse to process exit within a hook (requires `duration_ms` instrumentation) | Hook log `duration_ms` field |
| **Resolve→query delay** | Time between context7 resolve-library-id and matching query-docs tool_use events | Session JSONL timestamps |
| **Block recovery time** | Time from docs-guard block to next successful Write/Edit in same session | Session JSONL timestamps |
| **Mapping health** | Ratio of deterministic (exact/mapped) to fuzzy matches in hasLookup() | Hook log warn-level entries |
| **Flow completion rate** | query-docs calls / resolve-library-id calls (can exceed 100% if Claude skips resolve) | Session JSONL tool_use counts |
