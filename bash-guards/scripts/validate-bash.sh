#!/bin/bash
# Validates Bash tool calls — blocks banned commands and bad patterns.
#
# Rules:
#   1. Block `grep` (unless rg.exe is in the command) — use rg.exe instead
#   2. Block piping to head/tail/less/more — see full output, don't truncate
#   3. Block package runners — npx, bunx, pnpx, yarn/pnpm dlx, npm/yarn/pnpm exec,
#      and direct node_modules/.bin/ paths
#   4. Block test runners — vitest, jest, mocha, pytest, phpunit, rspec, cargo/go/dotnet/
#      deno/node test, npm/yarn/pnpm/bun test/run test, and node_modules/.bin/ test paths

set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$cmd" ]; then
  exit 0
fi

# Rule 1: grep is banned (unless rg.exe is present in the command)
if ! echo "$cmd" | grep -q 'rg.exe' 2>/dev/null; then
  if echo "$cmd" | grep -qE '(^|[;&|\s])grep\s' 2>/dev/null; then
    echo '{"decision":"block","reason":"grep is banned. Use rg.exe instead."}' >&2
    exit 2
  fi
fi

# Rule 2: Don't pipe to output-truncating commands
if echo "$cmd" | grep -qE '\|\s*(head|tail|less|more)\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Do not truncate output with head/tail/less/more. Read the full output directly."}' >&2
  exit 2
fi

# Rule 3: Block package runners — every variant
# 3a: npx, bunx, pnpx
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(npx|bunx|pnpx)\s' 2>/dev/null; then
  echo '{"decision":"block","reason":"Package runners (npx/bunx/pnpx) are banned. Do not run arbitrary packages."}' >&2
  exit 2
fi
# 3b: yarn dlx, pnpm dlx
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(yarn|pnpm)\s+dlx\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Package runners (yarn dlx/pnpm dlx) are banned. Do not run arbitrary packages."}' >&2
  exit 2
fi
# 3c: npm exec, yarn exec, pnpm exec
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(npm|yarn|pnpm)\s+exec\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Package runners (npm/yarn/pnpm exec) are banned. Do not run arbitrary packages."}' >&2
  exit 2
fi
# 3d: Direct node_modules/.bin/ paths
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(\./?)?node_modules/\.bin/' 2>/dev/null; then
  echo '{"decision":"block","reason":"Running binaries from node_modules/.bin/ directly is banned."}' >&2
  exit 2
fi

# Rule 4: Block test runners — every variant
# 4a: Direct test runner binaries
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(vitest|jest|mocha|pytest|phpunit|rspec)\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Test runners are banned. Do not run tests directly."}' >&2
  exit 2
fi
# 4b: Language-native test commands (cargo test, go test, dotnet test, deno test)
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(cargo|go|dotnet|deno)\s+test\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Test runners (cargo/go/dotnet/deno test) are banned. Do not run tests directly."}' >&2
  exit 2
fi
# 4c: node --test
if echo "$cmd" | grep -qE '(^|[;&|]\s*)node\s+--test\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Test runners (node --test) are banned. Do not run tests directly."}' >&2
  exit 2
fi
# 4d: PM test subcommands (npm/yarn/pnpm/bun test, npm/yarn/pnpm/bun run test)
if echo "$cmd" | grep -qE '(^|[;&|]\s*)(npm|yarn|pnpm|bun)\s+(test|run\s+test)\b' 2>/dev/null; then
  echo '{"decision":"block","reason":"Test runners (npm/yarn/pnpm/bun test) are banned. Do not run tests directly."}' >&2
  exit 2
fi

# All checks passed
exit 0
