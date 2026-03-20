#!/bin/bash
# Quick single-message test for the frustration detector
#
# Usage:
#   ./tests/run-quick-test.sh "BULL SHIT LEARN TO SEARCH"
#   ./tests/run-quick-test.sh "please fix the api endpoint"
#   echo "same error again" | ./tests/run-quick-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Get input from argument or stdin
if [ $# -gt 0 ]; then
  INPUT="$*"
else
  INPUT=$(cat)
fi

HOOK_PROMPT=$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].prompt' "$PROJECT_DIR/plugin.json")

CLASSIFY_PROMPT="$HOOK_PROMPT

USER MESSAGE TO CLASSIFY:
\"$INPUT\"

Respond with ONLY the classification label (NONE, MILD, HIGH, CIRCULAR_RETRY, or SCOPE_DRIFT) on the first line, followed by a brief reason on the second line. Nothing else."

echo "Input: \"$INPUT\""
echo "---"
echo "$CLASSIFY_PROMPT" | claude -p --model haiku 2>/dev/null
