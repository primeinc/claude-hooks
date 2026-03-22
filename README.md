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
| Truncation | `cmd \| head`, `cmd \| tail`, `cmd \| less`, `cmd \| more` | Read full output |
| Test pipe | `npm test \| cat`, `pytest \| grep PASS` | Don't hide test results |
| Package runners | `npx`, `bunx`, `pnpx`, `yarn dlx`, `pnpm dlx`, `npm exec` | Don't run arbitrary packages |
| node_modules bin | `node_modules/.bin/eslint` | Don't run binaries directly |

Rules are defined in `bash-guards/rules.json`. The engine parses commands into tokens and AST nodes, then applies policy against actual command structure — not regex substrings. Handles quotes, subshells, command substitution, and wrapper recursion (`bash -c`, `sh -lc`).

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

Run bash guard tests:

```bash
npm test
```

Run frustration detector benchmarks (requires `claude` CLI):

```bash
npm run benchmark
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
│   │   └── quick-detect.sh  # Deterministic classifier — bash + grep
│   └── tests/
│       ├── fixtures/
│       │   └── test-cases.json
│       ├── run-benchmarks.sh
│       └── run-quick-test.sh
├── bash-guards/
│   ├── rules.json           # Policy rules — all config, no code
│   └── scripts/
│       ├── validate-bash.js  # AST engine — tokenizer, parser, policy
│       └── test-guards.js    # Test harness (63 cases)
├── package.json
└── .gitignore
```

**No LLM in the pipeline.** The frustration detector uses deterministic bash + grep. The bash guard uses a Node.js tokenizer → AST → config-driven policy engine.

## Known Limitations

- **Hostile-but-clean language** ("nonsensical lazy approach", "this is garbage") is not detected. Deterministic regex can't distinguish hostile tone from technical descriptions without unacceptable false positive rates.
- **Varied phrasing** of mild corrections may not match. The MILD patterns cover common phrasings but not all possible wordings.
- **Plugin cache** does not auto-refresh from source. Bump the version in `marketplace.json` after making changes.

## Calibration

Detection patterns were derived from mining 194 Claude Code sessions containing 72,717 user messages. Empirical efficacy ratings (0.0–1.0 scale) informed which phrases to include and which thresholds to use.
