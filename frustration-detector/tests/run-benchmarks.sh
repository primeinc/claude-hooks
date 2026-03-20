#!/bin/bash
# Frustration detector benchmark runner — tests both layers
#
# Layer 1 (command hook): runs quick-detect.sh with simulated stdin
# Layer 2 (prompt hook): runs through claude -p for messages that pass Layer 1
#
# Usage: ./tests/run-benchmarks.sh [--verbose]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURES="$SCRIPT_DIR/fixtures/test-cases.json"
RESULTS_DIR="$SCRIPT_DIR/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/benchmark_${TIMESTAMP}.json"
VERBOSE="${1:-}"
QUICK_DETECT="$PROJECT_DIR/scripts/quick-detect.sh"
PROMPT_HOOK=$(jq -r '.hooks.UserPromptSubmit[0].hooks[1].prompt' "$PROJECT_DIR/plugin.json")

mkdir -p "$RESULTS_DIR"

TOTAL=$(jq 'length' "$FIXTURES")
PASS=0
FAIL=0
RESULTS="[]"

echo "=== Frustration Detector Benchmark (Hybrid v0.2.0) ==="
echo "Cases: $TOTAL | Layers: command + prompt"
echo "Timestamp: $TIMESTAMP"
echo ""

for i in $(seq 0 $((TOTAL - 1))); do
  TEST_ID=$(jq -r ".[$i].id" "$FIXTURES")
  INPUT=$(jq -r ".[$i].input" "$FIXTURES")
  EXPECTED=$(jq -r ".[$i].expected_class" "$FIXTURES")
  NOTES=$(jq -r ".[$i].notes" "$FIXTURES")

  # --- Layer 1: Command hook ---
  L1_INPUT=$(jq -n --arg p "$INPUT" '{"user_prompt": $p}')
  L1_OUTPUT=$(echo "$L1_INPUT" | bash "$QUICK_DETECT" 2>/dev/null || true)
  L1_MSG=$(echo "$L1_OUTPUT" | jq -r '.systemMessage // empty' 2>/dev/null || true)

  if [ -n "$L1_MSG" ]; then
    # Layer 1 fired — classify from its output
    if echo "$L1_MSG" | grep -q "CIRCULAR RETRY"; then
      ACTUAL="CIRCULAR_RETRY"
    elif echo "$L1_MSG" | grep -q "HIGH FRUSTRATION"; then
      ACTUAL="HIGH"
    else
      ACTUAL="UNKNOWN_L1"
    fi
    LAYER="L1"
    RESPONSE="$L1_MSG"
  else
    # --- Layer 2: Prompt hook ---
    CLASSIFY_PROMPT="$PROMPT_HOOK

USER MESSAGE TO CLASSIFY:
\"$INPUT\"

Respond with ONLY the classification label (NONE, MILD, CIRCULAR_RETRY, or SCOPE_DRIFT) on the first line, followed by a brief reason on the second line. Do NOT return HIGH — the command hook handles those."

    RESPONSE=$(echo "$CLASSIFY_PROMPT" | claude -p --model haiku 2>/dev/null || echo "ERROR")
    ACTUAL=$(echo "$RESPONSE" | tr -d '\r' | sed -n '1p' | grep -oE '(NONE|MILD|HIGH|CIRCULAR_RETRY|SCOPE_DRIFT)' || echo "PARSE_ERROR")
    LAYER="L2"
  fi

  # Compare
  if [ "$ACTUAL" = "$EXPECTED" ]; then
    STATUS="PASS"
    PASS=$((PASS + 1))
    ICON="+"
  else
    STATUS="FAIL"
    FAIL=$((FAIL + 1))
    ICON="X"
  fi

  printf "[%s] %-15s expected=%-15s got=%-15s [%s] %s\n" "$ICON" "$TEST_ID" "$EXPECTED" "$ACTUAL" "$LAYER" "$NOTES"

  if [ "$VERBOSE" = "--verbose" ] && [ "$STATUS" = "FAIL" ]; then
    echo "    Response: $(echo "$RESPONSE" | tr '\n' ' ' | cut -c1-120)"
    echo ""
  fi

  RESULTS=$(echo "$RESULTS" | jq --arg id "$TEST_ID" \
    --arg input "$INPUT" \
    --arg expected "$EXPECTED" \
    --arg actual "$ACTUAL" \
    --arg status "$STATUS" \
    --arg layer "$LAYER" \
    --arg response "$RESPONSE" \
    --arg notes "$NOTES" \
    '. + [{
      id: $id,
      input: $input,
      expected: $expected,
      actual: $actual,
      status: $status,
      layer: $layer,
      response: $response,
      notes: $notes
    }]')
done

# Summary
ACCURACY=$(awk "BEGIN {printf \"%.1f\", $PASS * 100 / $TOTAL}")

echo ""
echo "=== Results ==="
echo "Pass: $PASS / $TOTAL"
echo "Fail: $FAIL / $TOTAL"
echo "Accuracy: ${ACCURACY}%"
echo ""

# Layer distribution
L1_COUNT=$(echo "$RESULTS" | jq '[.[] | select(.layer == "L1")] | length')
L2_COUNT=$(echo "$RESULTS" | jq '[.[] | select(.layer == "L2")] | length')
echo "Layer 1 (command): $L1_COUNT cases handled"
echo "Layer 2 (prompt):  $L2_COUNT cases handled"
echo ""

# Category breakdown
echo "=== By Category ==="
for cat in NONE MILD HIGH CIRCULAR_RETRY SCOPE_DRIFT; do
  CAT_TOTAL=$(jq "[.[] | select(.expected_class == \"$cat\")] | length" "$FIXTURES")
  CAT_PASS=$(echo "$RESULTS" | jq "[.[] | select(.expected == \"$cat\" and .status == \"PASS\")] | length")
  if [ "$CAT_TOTAL" -gt 0 ]; then
    CAT_ACC=$(awk "BEGIN {printf \"%.0f\", $CAT_PASS * 100 / $CAT_TOTAL}")
    printf "%-18s %d/%d (%d%%)\n" "$cat" "$CAT_PASS" "$CAT_TOTAL" "$CAT_ACC"
  fi
done

# Misclassifications
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "=== Misclassifications ==="
  echo "$RESULTS" | jq -r '.[] | select(.status == "FAIL") | "  \(.id): expected=\(.expected) got=\(.actual) [\(.layer)] input=\"\(.input[0:80])...\""'
fi

# Save
SUMMARY=$(jq -n \
  --arg timestamp "$TIMESTAMP" \
  --argjson total "$TOTAL" \
  --argjson pass "$PASS" \
  --argjson fail "$FAIL" \
  --arg accuracy "$ACCURACY" \
  --argjson l1_count "$L1_COUNT" \
  --argjson l2_count "$L2_COUNT" \
  --argjson results "$RESULTS" \
  '{
    timestamp: $timestamp,
    version: "0.2.0-hybrid",
    total: $total,
    pass: $pass,
    fail: $fail,
    accuracy_pct: ($accuracy | tonumber),
    layer1_handled: $l1_count,
    layer2_handled: $l2_count,
    results: $results
  }')

echo "$SUMMARY" | jq . > "$RESULT_FILE"
echo ""
echo "Saved: $RESULT_FILE"
