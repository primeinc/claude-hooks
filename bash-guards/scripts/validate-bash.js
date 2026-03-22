#!/usr/bin/env node
"use strict";

/**
 * AST-based Bash command validator for Claude Code hooks.
 *
 * Parses shell commands into tokens → AST, then applies policy rules
 * loaded from ../rules.json against actual command nodes.
 *
 * Zero hardcoded policy. All rules are data.
 */

const { readFileSync } = require("fs");
const { join } = require("path");

// ── Load rules ───────────────────────────────────────────────────────

const CONFIG = JSON.parse(
  readFileSync(join(__dirname, "..", "rules.json"), "utf8")
);

// ── Shell tokenizer ──────────────────────────────────────────────────

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }

    if (ch === "#") {
      while (i < len && input[i] !== "\n") i++;
      continue;
    }

    // Two-char operators
    if (i + 1 < len) {
      const two = ch + input[i + 1];
      if (two === "&&" || two === "||") {
        tokens.push({ type: "op", value: two }); i += 2; continue;
      }
      if (two === ">>") { tokens.push({ type: "redir", value: two }); i += 2; continue; }
    }

    // Multi-char redirections
    if (i + 3 < len && input.slice(i, i + 4) === "2>&1") {
      tokens.push({ type: "redir", value: "2>&1" }); i += 4; continue;
    }
    if (i + 2 < len && input.slice(i, i + 3) === "2>>") {
      tokens.push({ type: "redir", value: "2>>" }); i += 3; continue;
    }
    if (i + 1 < len && input.slice(i, i + 2) === "2>") {
      tokens.push({ type: "redir", value: "2>" }); i += 2; continue;
    }

    // Single-char operators and structure
    if ("|;&()".includes(ch)) {
      tokens.push({ type: ch === "|" ? "op" : ch === "(" || ch === ")" ? "op" : "op", value: ch });
      i++; continue;
    }
    if (ch === ">" || ch === "<") {
      tokens.push({ type: "redir", value: ch }); i++; continue;
    }

    // Word
    let word = "";
    while (i < len) {
      const c = input[i];
      if (" \t\n".includes(c)) break;
      if ("|;&()><".includes(c)) break;
      if (c === "#" && word === "") break;
      if (i + 1 < len && (c + input[i + 1] === "&&" || c + input[i + 1] === "||")) break;

      if (c === "\\") {
        i++;
        if (i < len) { word += input[i]; i++; }
        continue;
      }
      if (c === "'") {
        i++;
        while (i < len && input[i] !== "'") { word += input[i]; i++; }
        if (i < len) i++;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < len && input[i] !== '"') {
          if (input[i] === "\\" && i + 1 < len) { word += input[i + 1]; i += 2; continue; }
          word += input[i]; i++;
        }
        if (i < len) i++;
        continue;
      }
      if (c === "$" && i + 1 < len && input[i + 1] === "(") {
        let depth = 1; word += "$("; i += 2;
        while (i < len && depth > 0) {
          if (input[i] === "(") depth++;
          if (input[i] === ")") depth--;
          if (depth > 0) word += input[i];
          i++;
        }
        continue;
      }
      word += c; i++;
    }
    if (word.length > 0) tokens.push({ type: "word", value: word });
  }
  return tokens;
}

// ── AST builder ──────────────────────────────────────────────────────

function buildAST(tokens) {
  const pipelines = [];
  let curPipeline = { segments: [] };
  let curSegment = { words: [] };

  for (const tok of tokens) {
    if (tok.type === "op") {
      if (tok.value === "|") {
        if (curSegment.words.length) curPipeline.segments.push(curSegment);
        curSegment = { words: [] };
      } else {
        if (curSegment.words.length) curPipeline.segments.push(curSegment);
        if (curPipeline.segments.length) pipelines.push(curPipeline);
        curPipeline = { segments: [] };
        curSegment = { words: [] };
      }
    } else if (tok.type === "word") {
      curSegment.words.push(tok.value);
    }
    // redirections are dropped — they're not commands
  }
  if (curSegment.words.length) curPipeline.segments.push(curSegment);
  if (curPipeline.segments.length) pipelines.push(curPipeline);
  return pipelines;
}

function parseSegment(segment) {
  const words = [];
  for (const w of segment.words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && words.length === 0) continue;
    words.push(w);
  }
  if (words.length === 0) return null;
  const full = words[0];
  const parts = full.replace(/\\/g, "/").split("/");
  return {
    exe: parts[parts.length - 1],
    full,
    args: words.slice(1),
  };
}

// ── Policy engine ────────────────────────────────────────────────────

function formatMsg(template, vars) {
  let msg = template;
  for (const [k, v] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return msg;
}

function checkRule(rule, cmd, args, fullPath, isInPipe, pipeline, segIdx, rawCommand) {
  switch (rule.type) {
    case "banned-command":
      if (!rule.commands.includes(cmd)) return null;
      if (rule.exempt_when && rawCommand.includes(rule.exempt_when)) return null;
      return formatMsg(rule.message, { cmd });

    case "banned-pipe-target":
      if (!isInPipe) return null;
      if (!rule.commands.includes(cmd)) return null;
      return formatMsg(rule.message, { cmd });

    case "banned-pipe-source":
      if (segIdx !== 0 || pipeline.segments.length <= 1) return null;
      if (cmd === rule.pattern || args.some((a) => a === rule.pattern) || args.join(" ").includes(rule.pattern)) {
        return rule.message;
      }
      return null;

    case "banned-subcommand":
      if (!rule.commands.includes(cmd)) return null;
      if (!rule.subcommands.includes(args[0])) return null;
      return formatMsg(rule.message, { cmd, sub: args[0] });

    case "banned-subcommand-chain":
      if (!rule.commands.includes(cmd)) return null;
      for (let ci = 0; ci < rule.chain.length; ci++) {
        if (args[ci] !== rule.chain[ci]) return null;
      }
      return formatMsg(rule.message, { cmd });

    case "banned-flag":
      if (!rule.commands.includes(cmd)) return null;
      if (!rule.flags.some((f) => args.includes(f))) return null;
      return formatMsg(rule.message, { cmd });

    case "banned-path-pattern":
      if (!fullPath.includes(rule.pattern) && !fullPath.replace(/\\/g, "/").includes(rule.pattern)) return null;
      return rule.message;

    default:
      return null;
  }
}

function evaluate(rawCommand) {
  const tokens = tokenize(rawCommand);
  const pipelines = buildAST(tokens);
  const wrappers = new Set(CONFIG.wrappers || []);

  for (const pipeline of pipelines) {
    for (let segIdx = 0; segIdx < pipeline.segments.length; segIdx++) {
      const parsed = parseSegment(pipeline.segments[segIdx]);
      if (!parsed) continue;

      const { exe, full, args } = parsed;
      const isInPipe = segIdx > 0;

      for (const rule of CONFIG.rules) {
        const msg = checkRule(rule, exe, args, full, isInPipe, pipeline, segIdx, rawCommand);
        if (msg) {
          return { decision: "block", reason: msg, match: { command: full, argv: args } };
        }
      }

      // Recurse into wrapper commands
      if (wrappers.has(exe)) {
        let cIdx = args.indexOf("-c");
        if (cIdx === -1) cIdx = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
        if (cIdx !== -1) {
          const nested = args.slice(cIdx + 1).join(" ");
          if (nested) {
            const result = evaluate(nested);
            if (result) return result;
          }
        }
      }
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let cmd;
  try { cmd = JSON.parse(input)?.tool_input?.command; } catch { process.exit(0); }
  if (!cmd || typeof cmd !== "string" || !cmd.trim()) process.exit(0);

  const result = evaluate(cmd);
  if (result) {
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason,
      },
    });
    process.stdout.write(output + "\n");
    process.exit(0);
  }
  process.exit(0);
});
