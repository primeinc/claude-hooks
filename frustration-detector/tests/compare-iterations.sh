#!/bin/bash
# Compare benchmark results across prompt iterations
#
# Usage:
#   ./tests/compare-iterations.sh
#
# Reads all benchmark_*.json files from results/ and shows accuracy trends.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

echo "=== Iteration Comparison ==="
echo ""
printf "%-25s %8s %8s %8s %10s\n" "Timestamp" "Total" "Pass" "Fail" "Accuracy"
echo "----------------------------------------------------------------------"

for f in "$RESULTS_DIR"/benchmark_*.json; do
  [ -f "$f" ] || continue
  TS=$(jq -r '.timestamp' "$f")
  TOTAL=$(jq '.total' "$f")
  PASS=$(jq '.pass' "$f")
  FAIL=$(jq '.fail' "$f")
  ACC=$(jq '.accuracy_pct' "$f")
  printf "%-25s %8d %8d %8d %9.1f%%\n" "$TS" "$TOTAL" "$PASS" "$FAIL" "$ACC"
done

echo ""
echo "=== Per-Category Trends (latest vs first) ==="

FIRST=$(ls "$RESULTS_DIR"/benchmark_*.json 2>/dev/null | sort | sed -n '1p')
LATEST=$(ls "$RESULTS_DIR"/benchmark_*.json 2>/dev/null | sort | sed -n '$p')

if [ "$FIRST" = "$LATEST" ] || [ -z "$FIRST" ]; then
  echo "Need at least 2 benchmark runs to compare."
  exit 0
fi

for cat in NONE MILD HIGH CIRCULAR_RETRY SCOPE_DRIFT; do
  FIRST_PASS=$(jq "[.results[] | select(.expected == \"$cat\" and .status == \"PASS\")] | length" "$FIRST")
  FIRST_TOTAL=$(jq "[.results[] | select(.expected == \"$cat\")] | length" "$FIRST")
  LATEST_PASS=$(jq "[.results[] | select(.expected == \"$cat\" and .status == \"PASS\")] | length" "$LATEST")
  LATEST_TOTAL=$(jq "[.results[] | select(.expected == \"$cat\")] | length" "$LATEST")

  if [ "$FIRST_TOTAL" -gt 0 ] && [ "$LATEST_TOTAL" -gt 0 ]; then
    F_ACC=$(awk "BEGIN {printf \"%.0f\", $FIRST_PASS * 100 / $FIRST_TOTAL}")
    L_ACC=$(awk "BEGIN {printf \"%.0f\", $LATEST_PASS * 100 / $LATEST_TOTAL}")
    DELTA=$((L_ACC - F_ACC))
    if [ "$DELTA" -gt 0 ]; then
      ARROW="+"
    elif [ "$DELTA" -lt 0 ]; then
      ARROW=""
    else
      ARROW="="
    fi
    printf "%-18s %d%% -> %d%% (%s%d%%)\n" "$cat" "$F_ACC" "$L_ACC" "$ARROW" "$DELTA"
  fi
done
