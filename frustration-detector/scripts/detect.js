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
// Each rule: { pattern: RegExp, category: string, maxLength?: number, exclude?: RegExp }
// Rules are evaluated in order. First match wins.
// maxLength constrains the rule to short messages only (reduces false positives).

const RULES = [
  // HIGH: directed profanity — aimed at Claude or Claude's output
  // No trailing \b on profanity stems so inflected forms (fucking, shitty) match.
  // Direction markers: you/your/you're, this/that, what the, holy
  {
    pattern: /\b(your|you're)\b.{0,40}\b(fuck|shit|crap|damn|cunt|ass\b)|\b(fuck|shit|crap|damn|cunt)\w*.{0,20}\b(you|your|you're)\b|\byou\b.{0,10}\b(fuck|shit|crap|damn|cunt|ass\b)/i,
    category: "HIGH",
  },

  // HIGH: exclamatory profanity — "what the fuck", "holy shit", "that's bullshit", "that shit"
  {
    pattern: /(what the|holy|oh my|are you)\s+\w*(fuck|shit|crap|damn|hell)|\b(this is|that's|that is) (fuck|shit|crap|bull\s*shit|damn)|\bthat (shit|fuck|crap)\b.{0,10}(doesn|doesn|doesnt|won|isn|not|never|broken|wrong|fail)|\b(bull\s*shit|bullshit|cunt)\b/i,
    category: "HIGH",
  },

  // HIGH: multiple profanity words in one message = rage regardless of direction
  {
    pattern: /\b(fuck|shit|damn|crap|cunt)\w*\b.+\b(fuck|shit|damn|crap|cunt)\w*\b/i,
    category: "HIGH",
  },

  // HIGH: profanity in ALL CAPS context (rage regardless of direction)
  {
    pattern: /[A-Z]{3,}.{0,20}\b(FUCK|SHIT|DAMN|CRAP|CUNT|ASS)\b|\b(FUCK|SHIT|DAMN|CRAP|CUNT)\w*.{0,20}[A-Z]{3,}/,
    category: "HIGH",
  },

  // HIGH: profanity typos from rage-typing (nobody rage-types calmly)
  {
    pattern: /\b(fukc|fuk|fcuk|sht)\b/i,
    category: "HIGH",
  },

  // HIGH: short angry acronyms (WTF, FFS, JFC, OMFG)
  {
    pattern: /\b(WTF|FFS|JFC|OMFG)\b/i,
    category: "HIGH",
    maxLength: 120,
  },

  // HIGH: ALL CAPS short messages (3+ consecutive capitalized words)
  // Excludes messages ending with ? — those are caps-lock questions, not rage.
  {
    pattern: /(\b[A-Z]{2,}\b\s+){2,}\b[A-Z]{2,}\b/,
    category: "HIGH",
    maxLength: 80,
    exclude: /\?\s*$/,
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
    pattern: /\b(still (broken|failing|not working|wrong|guessing|making things up)|keeps? (failing|breaking|happening)|keep .{0,15}(same|failing|wrong))\b/i,
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
    maxLength: 200,
  },

  // SCOPE DRIFT: explicit mismatch
  {
    pattern: /\b(I asked (for|you to)|that's not the|wrong (problem|thing|issue))\b/i,
    category: "SCOPE_DRIFT",
    maxLength: 200,
  },

  // MILD: polite corrections (short messages only)
  {
    pattern: /\b(sorry I was.?t clear|is that (really )?best practice|are you sure|that.?s not (right|correct)|wrong file|check the docs|doesn.?t work on|you misunderstood|your wrong|you're wrong)\b/i,
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
    if (rule.exclude && rule.exclude.test(prompt)) continue;
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
