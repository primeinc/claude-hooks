#!/bin/bash
# Fast deterministic frustration detector — Layer 1
#
# Catches zero-ambiguity signals: profanity, ALL CAPS anger, explicit circular retries.
# Returns systemMessage immediately for clear cases.
# Exits 0 silently for ambiguous/clean messages (lets prompt hook Layer 2 handle them).

set -euo pipefail

input=$(cat)
prompt=$(echo "$input" | jq -r '.user_prompt // empty')

if [ -z "$prompt" ]; then
  exit 0
fi

HIGH_MSG='{"continue":true,"suppressOutput":false,"systemMessage":"<user-prompt-submit-hook>\nHIGH FRUSTRATION. The user is angry. STOP your current approach immediately. Re-read their ORIGINAL request from the start of the conversation. Identify where you diverged from what they wanted. Do NOT continue what you were doing — change course. Do not apologize — just fix it.\n</user-prompt-submit-hook>"}'

CIRCULAR_MSG='{"continue":true,"suppressOutput":false,"systemMessage":"<user-prompt-submit-hook>\nCIRCULAR RETRY DETECTED. The user is reporting the same failure persists. Your current approach is WRONG. Do not retry it. Gather new evidence: read docs, check types, inspect actual error output. Try a fundamentally different approach.\n</user-prompt-submit-hook>"}'

# --- PROFANITY: zero ambiguity, always HIGH ---
if echo "$prompt" | grep -qiE '\b(fuck|shit|bullshit|bull\s*shit)\b'; then
  echo "$HIGH_MSG"
  exit 0
fi

# --- CAPS ANGER: WTF, FFS as standalone angry signals ---
# Must be short messages (under 60 chars) to avoid false positives
length="${#prompt}"
if [ "$length" -lt 60 ]; then
  if echo "$prompt" | grep -qE '\bWTF\b|\bFFS\b'; then
    echo "$HIGH_MSG"
    exit 0
  fi
  if echo "$prompt" | grep -qE '^\s*(STOP|WRONG|DUDE)\s*$|^\s*DUDE\s+STOP\s*$'; then
    echo "$HIGH_MSG"
    exit 0
  fi
fi

# --- CIRCULAR RETRY: deterministic phrases that always mean "same failure persists" ---
if echo "$prompt" | grep -qiE '\bsame (error|issue|problem|bug|failure)\b'; then
  if echo "$prompt" | grep -qiE "(still|again|not working|doesn't work|didn't work)"; then
    echo "$CIRCULAR_MSG"
    exit 0
  fi
fi

# All other cases: exit clean, let prompt hook (Layer 2) handle ambiguous signals
exit 0
