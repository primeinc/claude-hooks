#!/bin/bash
# Deterministic frustration detector — command hook only, no LLM layer.
#
# Categories:
#   HIGH       — profanity, ALL CAPS anger, hostile short messages
#   CIRCULAR   — "same error/problem" + "still/again"
#   MILD       — polite corrections, "wrong file", "that's not right"
#   SCOPE_DRIFT — "not what I asked", "I said X not Y"
#
# Returns systemMessage for matches. Exits 0 silently for clean input.

set -euo pipefail

input=$(cat)
prompt=$(echo "$input" | jq -r '.prompt // .user_prompt // empty' 2>/dev/null)

if [ -z "$prompt" ]; then
  exit 0
fi

HIGH_MSG='{"continue":true,"systemMessage":"<user-prompt-submit-hook>\nHIGH FRUSTRATION. The user is angry. STOP your current approach immediately. Re-read their ORIGINAL request from the start of the conversation. Identify where you diverged from what they wanted. Do NOT continue what you were doing — change course. Do not apologize — just fix it.\n</user-prompt-submit-hook>"}'

CIRCULAR_MSG='{"continue":true,"systemMessage":"<user-prompt-submit-hook>\nCIRCULAR RETRY DETECTED. The user is reporting the same failure persists. Your current approach is WRONG. Do not retry it. Gather new evidence: read docs, check types, inspect actual error output. Try a fundamentally different approach.\n</user-prompt-submit-hook>"}'

MILD_MSG='{"continue":true,"systemMessage":"<user-prompt-submit-hook>\nMILD CORRECTION. Pause. Re-read what the user actually asked. Verify your current approach addresses their request before continuing.\n</user-prompt-submit-hook>"}'

SCOPE_MSG='{"continue":true,"systemMessage":"<user-prompt-submit-hook>\nSCOPE DRIFT. You are solving the wrong problem. Re-read the original request and realign.\n</user-prompt-submit-hook>"}'

length="${#prompt}"

# --- HIGH: profanity (any word form) ---
# No trailing \b on longer stems so "fucking", "shitty", "crappy", "damned" all match.
# \bass\b keeps trailing boundary to avoid "assign", "assert", "class".
if echo "$prompt" | grep -qiE '\b(fuck|shit|bullshit|bull[[:space:]]*shit|damn|crap)|\bass\b'; then
  echo "$HIGH_MSG"
  exit 0
fi

# --- HIGH: short angry messages ---
if [ "$length" -lt 80 ]; then
  # WTF, FFS, JFC, OMG as anger
  if echo "$prompt" | grep -qE '\b(WTF|FFS|JFC)\b'; then
    echo "$HIGH_MSG"
    exit 0
  fi
  # ALL CAPS short messages (3+ consecutive cap words)
  if echo "$prompt" | grep -qE '(\b[A-Z]{2,}\b\s+){2,}\b[A-Z]{2,}\b'; then
    echo "$HIGH_MSG"
    exit 0
  fi
  # Standalone angry words
  if echo "$prompt" | grep -qE '^\s*(STOP|WRONG|DUDE|BRO)\s*$|^\s*DUDE\s+STOP\s*$'; then
    echo "$HIGH_MSG"
    exit 0
  fi
fi

# --- CIRCULAR RETRY ---
if echo "$prompt" | grep -qiE '\b(same (error|issue|problem|bug|failure)|tried this before|tried that already|already tried|we tried that)\b'; then
  echo "$CIRCULAR_MSG"
  exit 0
fi
if echo "$prompt" | grep -qiE '\b(still (broken|failing|not working|wrong)|keeps (failing|breaking|happening))\b'; then
  echo "$CIRCULAR_MSG"
  exit 0
fi
if echo "$prompt" | grep -qiE "\b(didn't work last time|that didn't work|that doesn't work|not working again)\b"; then
  echo "$CIRCULAR_MSG"
  exit 0
fi

# --- SCOPE DRIFT (short messages only — long ones are instructions, not complaints) ---
if [ "$length" -lt 120 ]; then
  if echo "$prompt" | grep -qiE "\b(not what I asked|that's not what I (asked|meant|said)|I said .+ not )|you keep (doing|changing|adding)\b"; then
    echo "$SCOPE_MSG"
    exit 0
  fi
  if echo "$prompt" | grep -qiE "\b(I asked (for|you to)|that's not the|wrong (problem|thing|issue))\b"; then
    echo "$SCOPE_MSG"
    exit 0
  fi
fi

# --- MILD (short messages, polite corrections) ---
if [ "$length" -lt 200 ]; then
  if echo "$prompt" | grep -qiE "\b(sorry I was.?t clear|is that (really )?best practice|are you sure|that.?s not (right|correct)|wrong file|check the docs|doesn.?t work on)\b"; then
    echo "$MILD_MSG"
    exit 0
  fi
fi

# All clean — no output, no interference
exit 0
