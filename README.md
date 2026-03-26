# claude-hooks

Deterministic frustration detection + AST-based bash command guards for Claude Code. No LLM in the hook pipeline.

## What it does

**Frustration Detector** — Injects behavioral correction into Claude's context when it detects user frustration:

| Category | Trigger | Effect |
|----------|---------|--------|
| HIGH | Profanity, ALL CAPS anger, hostile short messages | "STOP. Re-read the original request. Change course." |
| CIRCULAR_RETRY | "same error again", "still broken", "already tried that" | "Your approach is wrong. Gather new evidence. Try something different." |
| SCOPE_DRIFT | "not what I asked", "I said X not Y" | "Re-read the original request. You're solving the wrong problem." |
| MILD | "sorry I wasn't clear", "wrong file", "check the docs" | "Pause. Re-read what the user asked. Verify your approach." |

Does **not** block messages. Returns `continue: true` with a `systemMessage` that nudges Claude without interrupting the user.

**Bash Guards** — AST-based command validator that blocks bad patterns before execution:

| Rule | Blocked | Alternative |
|------|---------|-------------|
| `find` | `find . -name foo` | rg.exe |
| `grep` | `grep -r pattern .` | rg.exe |
| Truncation | `cmd \| head`, `cmd \| tail` | Read full output |
| Test pipe | `npm test \| cat` | Don't hide test results |
| Test redirect | `npm test > file.txt` | Read output directly |
| Test silent | `npm test --silent`, `--quiet` | Read full output |
| Test reporter | `--reporter=dot` (minimal) | Use `--reporter=verbose` |
| Test loglevel | `npm test --loglevel silent` | Read full output |
| Output to /dev/null | `cmd > /dev/null` | Read full output |
| Package runners | `npx`, `bunx`, `pnpx` (except `npx skills`) | Don't run arbitrary packages |
| node_modules path | `node node_modules/eslint/bin/eslint.js` | Use `npm run lint` |
| Lint standards | `npm run lint` without `--no-inline-config` | Fix package.json or eslint config |

Rules are defined in `bash-guards/rules.json`. The engine parses commands into tokens and AST, then applies policy against actual command structure — not regex substrings. Handles quotes, subshells, command substitution (`$()`, backticks), process substitution (`<()`), wrapper recursion (`bash -c`, `sh -lc`), and prefix commands (`env`, `exec`, `xargs`).

## Install

This repo is a local marketplace. Register it in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "local-hooks": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/claude-hooks"
      }
    }
  }
}
```

Then install the plugin:

```
claude plugin install claude-hooks@local-hooks
```

To update after changes, commit your changes, then run:

```
claude plugin update claude-hooks@local-hooks
```

## Development

**Use `--plugin-dir` to bypass the plugin cache:**

```bash
claude --plugin-dir /path/to/claude-hooks
```

This loads hooks directly from your source directory. Edits take effect on next session start — no version bumps or cache deletion needed.

Without `--plugin-dir`, the plugin is cached at `~/.claude/plugins/cache/` at install time. Source directory edits have **zero effect** on running hooks until the cache is refreshed (version bump in marketplace.json).

## Testing

Run all tests:

```bash
npm test
```

Run individually:

```bash
npm run test:guards       # bash guard cases
npm run test:frustration  # frustration detector cases
```

Benchmark with saved results:

```bash
npm run benchmark         # save timestamped results to tests/results/
npm run compare           # compare accuracy trends across benchmark runs
```

## Architecture

```
claude-hooks/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest (name, description)
│   └── marketplace.json     # Local marketplace (version lives here)
├── hooks/
│   └── hooks.json           # Hook definitions (auto-discovered)
├── frustration-detector/
│   ├── scripts/
│   │   ├── detect.js            # Deterministic classifier — regex patterns
│   │   ├── test-frustration.js  # Test harness
│   │   └── compare-benchmarks.js # Benchmark comparison across runs
│   └── tests/
│       └── fixtures/
│           └── test-cases.json
├── bash-guards/
│   ├── rules.json           # Policy rules — all config, no code
│   └── scripts/
│       ├── validate-bash.js  # AST engine — tokenizer, parser, policy
│       └── test-guards.js    # Test harness
├── docs-guard/
│   ├── src/
│   │   ├── gate.js          # PreToolUse gate — blocks Write/Edit without doc lookup
│   │   ├── tracker.js       # PostToolUse tracker — records doc lookups
│   │   ├── extract.js       # AST-based import extraction (ts-morph)
│   │   ├── state.js         # Session state (lookups, mappings, resolve attempts)
│   │   └── session-clear.js # SessionStart — clears state on fresh sessions
│   └── tests/
│       ├── test-pipeline.js     # Integration tests (tracker + gate)
│       ├── test-extract.js      # Unit tests for import extraction
│       ├── test-real-ids.js     # Real context7 ID matching tests
│       └── test-failure-modes.js # Degraded mode, mapping, D4/D5 regression tests
├── lib/
│   └── logger.js            # Shared structured JSON logger
├── scripts/
│   └── analyze-sessions.js  # Session JSONL analytics
├── package.json
└── .gitignore
```

**No LLM in the pipeline.** All hooks are Node.js. The frustration detector uses regex pattern matching. The bash guard uses a tokenizer → AST → config-driven policy engine.

## Hook Contract

All hooks follow the [first-party hook contract](https://docs.anthropic.com/en/docs/claude-code/hooks). Key details:

| Aspect | First-party docs | This repo | Notes |
|--------|-----------------|-----------|-------|
| **PreToolUse deny** | `{ hookSpecificOutput: { permissionDecision: "deny" }, systemMessage }` | Also includes `hookEventName` and `permissionDecisionReason` | `hookEventName` is undocumented but required by runtime (removing it caused a 4-day bypass — cf1c742). `permissionDecisionReason` is harmless extra. |
| **PreToolUse allow** | Exit 0, no stdout | Exit 0, no stdout | Aligned |
| **PostToolUse stdin** | `tool_result` field | Reads `tool_result` with `tool_response` fallback | Docs say `tool_result`. Fallback for older builds. |
| **UserPromptSubmit** | `{ continue, suppressOutput?, systemMessage? }` | `{ continue: true, systemMessage }` | Aligned (suppressOutput is optional) |
| **SessionStart stdin** | Common fields only (no `source` documented) | Reads `source` to distinguish startup from resume | `source` is undocumented. Code defaults to clearing state if field is missing (fail-safe). |
| **Matchers** | Regex or `*` wildcard | `*`, `Bash`, `Write\|Edit`, pipe-delimited | Aligned |
| **hooks.json** | `{ hooks: { EventName: [...] } }` wrapper | Same | Aligned |
| **Exit codes** | 0=allow, 0+JSON=decision, 2+stderr=block | Uses exit 0 + JSON for all decisions | Aligned (JSON mode) |
| **Hook events used** | 9 available | 4 used: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart | SessionEnd, Stop, SubagentStop, PreCompact, Notification not needed |

## Docs-Guard: Context7 Usage

The docs-guard enforces a **docs-before-code** workflow. Before writing code that uses a third-party library, Claude must look up the docs. Multiple doc sources are supported:

| Source | When to use | What counts as completion |
|--------|------------|--------------------------|
| **context7** (preferred) | npm packages with context7 coverage | `resolve-library-id` → `query-docs`. Resolve alone does NOT count. |
| **WebSearch / WebFetch** | Fallback when context7 fails, or for non-npm libraries | Any search/fetch that mentions the library name |
| **learndocs** | Microsoft/Azure-specific docs | Any learndocs search or fetch |

**How the flow works:**
1. `resolve-library-id` records a **mapping** (npm name → context7 IDs) but is NOT a lookup
2. `query-docs` records the actual **lookup** under the mapped npm name
3. The gate checks if each library used in Write/Edit has a lookup recorded
4. If context7 fails (resolve returns wrong library, query-docs times out), WebSearch/WebFetch are accepted as fallbacks

**Degraded mode:** If resolve was called but query-docs never completed, the gate shows a distinct "DOCS LOOKUP INCOMPLETE" message instead of "DOCS FIRST" — recognizing the intent was there.

**Testing:** Tests use `recordLookup()` and `recordMapping()` directly — no real MCP calls. Fixture-based tests in `test-failure-modes.js` cover the full `parseContext7Ids()` → mapping → lookup flow using real production response text.

## Known Limitations

**Frustration detector:**
- **ALL CAPS instructions** with 5+ consecutive capitalized words trigger HIGH even when they're commands, not rage. 3-4 cap words are allowed (instructions like "GET THE DOCS", "STOP CONDITION NOT MET").
- **Hostile-but-clean language** ("nonsensical lazy approach", "this is garbage") is not detected without unacceptable false positive rates.
- **Casual profanity is mostly handled** but edge cases remain. Direction detection uses proximity heuristics that can misjudge at boundary distances.

**Bash guards:**
- **Foreign language eval** (`python -c "os.system('find .')"`, `node -e "execSync('grep')"`) cannot be caught without interpreting the target language. Shell `eval` is caught.
- **Subshell redirect** (`(npm test) 2>/dev/null`) — redirect on the subshell wrapper is not checked.
- **Heredoc content** is stripped before scanning (data, not commands). **Herestrings** (`bash <<< "find ."`) are evaluated and blocked correctly.

**Plugin cache** does not auto-refresh from source. Bump the version in `plugin.json` and run `claude plugin update` after making changes.

## Calibration

Detection patterns were derived from mining 194 Claude Code sessions containing 72,717 user messages. Empirical efficacy ratings (0.0–1.0 scale) informed which phrases to include and which thresholds to use.
