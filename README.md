# claude-hooks

Deterministic frustration detection + bash command guards for Claude Code. Pure bash, zero latency, no LLM in the hook pipeline.

## What it does

**Frustration Detector** — Injects behavioral correction into Claude's context when it detects user frustration:

| Category | Trigger | Effect |
|----------|---------|--------|
| HIGH | Profanity, ALL CAPS anger, hostile short messages | "STOP. Re-read the original request. Change course." |
| CIRCULAR_RETRY | "same error again", "still broken", "already tried that" | "Your approach is wrong. Gather new evidence. Try something different." |
| SCOPE_DRIFT | "not what I asked", "I said X not Y" | "Re-read the original request. You're solving the wrong problem." |
| MILD | "sorry I wasn't clear", "wrong file", "check the docs" | "Pause. Re-read what the user asked. Verify your approach." |

Does **not** block messages. Returns `continue: true` with a `systemMessage` that nudges Claude without interrupting the user.

**Bash Guards** — Blocks bad command patterns before execution:

| Rule | Blocked | Alternative |
|------|---------|-------------|
| `find` | `find . -name foo` | Use `rg.exe` or Glob tool |
| `grep` | `grep -r pattern .` | Use `rg.exe` or Grep tool |
| Truncation | `cmd \| head`, `cmd \| tail`, `cmd \| less` | Read full output directly |

## Install

Add the marketplace to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-hooks": {
      "source": {
        "source": "github",
        "repo": "primeinc/claude-hooks"
      }
    }
  }
}
```

Then in Claude Code, run `/plugins` and enable `claude-hooks`.

## Development

**Use `--plugin-dir` to bypass the plugin cache:**

```bash
claude --plugin-dir /path/to/claude-hooks
```

This loads hooks directly from your source directory. Edits take effect on next session start — no version bumps or cache deletion needed.

Without `--plugin-dir`, the plugin is cached at `~/.claude/plugins/cache/` at install time. Source directory edits have **zero effect** on running hooks until the cache is refreshed (version bump or manual cache deletion).

## Testing

Run the full test suite (33 cases):

```bash
cd claude-hooks
while IFS= read -r line; do
  id=$(echo "$line" | jq -r '.id')
  input=$(echo "$line" | jq -r '.input')
  expected=$(echo "$line" | jq -r '.expected_class')
  result=$(echo "{\"prompt\":$(echo "$input" | jq -Rs .)}" \
    | bash frustration-detector/scripts/quick-detect.sh 2>/dev/null)
  if [ -z "$result" ]; then actual="NONE"
  elif echo "$result" | grep -q "HIGH FRUSTRATION"; then actual="HIGH"
  elif echo "$result" | grep -q "CIRCULAR RETRY"; then actual="CIRCULAR_RETRY"
  elif echo "$result" | grep -q "MILD CORRECTION"; then actual="MILD"
  elif echo "$result" | grep -q "SCOPE DRIFT"; then actual="SCOPE_DRIFT"
  else actual="UNKNOWN"; fi
  mark="PASS"; [ "$actual" != "$expected" ] && mark="FAIL"
  printf "%-12s %-18s %-18s %s\n" "$id" "$expected" "$actual" "$mark"
done < <(jq -c '.[]' frustration-detector/tests/fixtures/test-cases.json)
```

Test individual inputs:

```bash
echo '{"prompt":"your message here"}' | bash frustration-detector/scripts/quick-detect.sh
echo '{"tool_input":{"command":"find . -name foo"}}' | bash bash-guards/scripts/validate-bash.sh
```

## Architecture

```
claude-hooks/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest (name, version, description)
│   └── marketplace.json     # Marketplace registration
├── hooks/
│   └── hooks.json           # Hook definitions (auto-discovered by Claude Code)
├── frustration-detector/
│   ├── scripts/
│   │   └── quick-detect.sh  # Deterministic classifier — bash + grep
│   └── tests/
│       └── fixtures/
│           └── test-cases.json  # 33 test cases
├── bash-guards/
│   ├── scripts/
│   │   └── validate-bash.sh # Command validator — blocks find/grep/truncation
│   └── tests/
│       └── fixture-*.json   # Per-rule test fixtures
└── .gitignore
```

**No LLM in the pipeline.** An earlier version used a prompt hook (Layer 2) for subtle signal detection. It was removed because prompt hooks cannot reliably ignore profanity — the LLM reacts to it regardless of instructions, blocking user messages instead of passing through. The deterministic bash approach is faster, predictable, and doesn't interfere with the user.

## Known Limitations

- **Hostile-but-clean language** ("nonsensical lazy approach", "this is garbage") is not detected. Deterministic regex can't distinguish hostile tone from technical descriptions without unacceptable false positive rates.
- **Varied phrasing** of mild corrections may not match. The MILD patterns cover common phrasings but not all possible wordings.
- **Plugin cache** does not auto-refresh from source. Bump the version in `plugin.json` or delete `~/.claude/plugins/cache/` after making changes.
- **Bash guard regex** matches patterns inside quoted strings. `echo "find me"` will trigger the `find` guard. This is a fundamental limitation of line-based regex on shell commands.

## Calibration

Detection patterns were derived from mining 194 Claude Code sessions containing 72,717 user messages. Empirical efficacy ratings (0.0–1.0 scale) informed which phrases to include and which thresholds to use.
