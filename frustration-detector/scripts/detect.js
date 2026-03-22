#!/usr/bin/env node
"use strict";

/**
 * Deterministic frustration detector for Claude Code hooks.
 *
 * Classifies user prompts into: HIGH, CIRCULAR_RETRY, SCOPE_DRIFT, MILD, or NONE.
 * All patterns are regex — no LLM in the pipeline.
 *
 * Reads JSON from stdin (UserPromptSubmit hook format).
 * Outputs JSON with systemMessage for matches, or exits silently for clean input.
 *
 * Ported from quick-detect.sh to eliminate the bash/node runtime split.
 */

// ── Messages ────────────────────────────────────────────────────────

const MESSAGES = {
  HIGH: [
    "HIGH FRUSTRATION. The user is angry. STOP your current approach immediately.",
    "Re-read their ORIGINAL request from the start of the conversation.",
    "Identify where you diverged from what they wanted.",
    "Do NOT continue what you were doing — change course.",
    "Do not apologize — just fix it.",
  ].join(" "),

  CIRCULAR_RETRY: [
    "CIRCULAR RETRY DETECTED. The user is reporting the same failure persists.",
    "Your current approach is WRONG. Do not retry it.",
    "Gather new evidence: read docs, check types, inspect actual error output.",
    "Try a fundamentally different approach.",
  ].join(" "),

  SCOPE_DRIFT: [
    "SCOPE DRIFT. You are solving the wrong problem.",
    "Re-read the original request and realign.",
  ].join(" "),

  MILD: [
    "MILD CORRECTION. Pause. Re-read what the user actually asked.",
    "Verify your current approach addresses their request before continuing.",
  ].join(" "),
};

// ── Patterns ────────────────────────────────────────────────────────
//
// Each rule: { pattern: RegExp, category: string, maxLength?: number }
// Rules are evaluated in order. First match wins.
// maxLength constrains the rule to short messages only (reduces false positives).

const RULES = [
  // HIGH: profanity (any word form)
  // No trailing \b on longer stems so "fucking", "shitty", "crappy", "damned" all match.
  // \bass\b keeps trailing boundary to avoid "assign", "assert", "class".
  {
    pattern: /\b(fuck|shit|bullshit|bull\s*shit|damn|crap)|\bass\b/i,
    category: "HIGH",
  },

  // HIGH: short angry acronyms (WTF, FFS, JFC)
  {
    pattern: /\b(WTF|FFS|JFC)\b/,
    category: "HIGH",
    maxLength: 80,
  },

  // HIGH: ALL CAPS short messages (3+ consecutive capitalized words)
  {
    pattern: /(\b[A-Z]{2,}\b\s+){2,}\b[A-Z]{2,}\b/,
    category: "HIGH",
    maxLength: 80,
  },

  // HIGH: standalone angry words
  {
    pattern: /^\s*(STOP|WRONG|DUDE|BRO)\s*$|^\s*DUDE\s+STOP\s*$/,
    category: "HIGH",
    maxLength: 80,
  },

  // CIRCULAR RETRY: same error/problem references
  {
    pattern: /\b(same (error|issue|problem|bug|failure)|tried this before|tried that already|already tried|we tried that)\b/i,
    category: "CIRCULAR_RETRY",
  },

  // CIRCULAR RETRY: persistence signals
  {
    pattern: /\b(still (broken|failing|not working|wrong)|keeps (failing|breaking|happening))\b/i,
    category: "CIRCULAR_RETRY",
  },

  // CIRCULAR RETRY: past-tense failure references
  {
    pattern: /\b(didn't work last time|that didn't work|that doesn't work|not working again)\b/i,
    category: "CIRCULAR_RETRY",
  },

  // SCOPE DRIFT: wrong problem (short messages only — long ones are instructions)
  {
    pattern: /\b(not what I asked|that's not what I (asked|meant|said)|I said .+ not )|you keep (doing|changing|adding)\b/i,
    category: "SCOPE_DRIFT",
    maxLength: 120,
  },

  // SCOPE DRIFT: explicit mismatch
  {
    pattern: /\b(I asked (for|you to)|that's not the|wrong (problem|thing|issue))\b/i,
    category: "SCOPE_DRIFT",
    maxLength: 120,
  },

  // MILD: polite corrections (short messages only)
  {
    pattern: /\b(sorry I was.?t clear|is that (really )?best practice|are you sure|that.?s not (right|correct)|wrong file|check the docs|doesn.?t work on)\b/i,
    category: "MILD",
    maxLength: 200,
  },
];

// ── Classifier ──────────────────────────────────────────────────────

function classify(prompt) {
  if (!prompt || typeof prompt !== "string") return null;

  const length = prompt.length;

  for (const rule of RULES) {
    if (rule.maxLength && length >= rule.maxLength) continue;
    if (rule.pattern.test(prompt)) return rule.category;
  }

  return null;
}

// ── Hook output ─────────────────────────────────────────────────────

function hookOutput(category) {
  const msg = MESSAGES[category];
  if (!msg) return null;
  return {
    continue: true,
    systemMessage: `<user-prompt-submit-hook>\n${msg}\n</user-prompt-submit-hook>`,
  };
}

// ── Main ────────────────────────────────────────────────────────────

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    let prompt;
    try {
      const parsed = JSON.parse(input);
      prompt = parsed.prompt || parsed.user_prompt;
    } catch {
      process.exit(0);
    }

    if (!prompt || typeof prompt !== "string") process.exit(0);

    const category = classify(prompt);
    if (category) {
      const output = hookOutput(category);
      if (output) {
        process.stdout.write(JSON.stringify(output) + "\n");
      }
    }
    process.exit(0);
  });
}

// Export for testing
module.exports = { classify, hookOutput, RULES, MESSAGES };
