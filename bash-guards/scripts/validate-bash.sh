#!/bin/bash
# Validates Bash tool calls — blocks banned commands and bad patterns.
# Consolidates 4 inline settings.json hooks into one script.
#
# Rules:
#   1. Block `find` — use rg.exe instead
#   2. Block `grep` (unless rg.exe is in the command) — use rg.exe instead
#   3. Block piping test output — read full output directly
#   4. Block piping to head/tail — see full output, don't truncate

set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$cmd" ]; then
  exit 0
fi

# Rule 1: find is banned
if echo "$cmd" | grep -qE '(^|[;&|\s])find\s' 2>/dev/null; then
  echo '{"decision":"block","reason":"find is banned. Use rg.exe instead."}' >&2
  exit 2
fi

# Rule 2: grep is banned (unless rg.exe is present in the command)
if ! echo "$cmd" | grep -q 'rg.exe' 2>/dev/null; then
  if echo "$cmd" | grep -qE '(^|[;&|\s])grep\s' 2>/dev/null; then
    echo '{"decision":"block","reason":"grep is banned. Use rg.exe instead."}' >&2
    exit 2
  fi
fi

# Rule 3: Don't pipe test output
if echo "$cmd" | grep -qE 'test.*\|' 2>/dev/null; then
  echo '{"decision":"block","reason":"Do not pipe test output. Run the test command directly and read the full output."}' >&2
  exit 2
fi

# Rule 4: Don't pipe to head/tail
if echo "$cmd" | grep -qE '\|\s*(head|tail)\s' 2>/dev/null; then
  echo '{"decision":"block","reason":"Do not pipe output to head/tail. You need to see the full output, not truncate it."}' >&2
  exit 2
fi

# All checks passed
exit 0
