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
      tokens.push({ type: "op", value: ch });
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
  let curSegment = { words: [], redirects: [] };

  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok.type === "op") {
      if (tok.value === "|") {
        if (curSegment.words.length) curPipeline.segments.push(curSegment);
        curSegment = { words: [], redirects: [] };
      } else {
        if (curSegment.words.length) curPipeline.segments.push(curSegment);
        if (curPipeline.segments.length) pipelines.push(curPipeline);
        curPipeline = { segments: [] };
        curSegment = { words: [], redirects: [] };
      }
    } else if (tok.type === "redir") {
      // Capture redirect operator + next word as target
      const next = tokens[ti + 1];
      if (next && next.type === "word") {
        curSegment.redirects.push({ op: tok.value, target: next.value });
        ti++; // skip the target word
      } else {
        curSegment.redirects.push({ op: tok.value, target: "" });
      }
    } else if (tok.type === "word") {
      curSegment.words.push(tok.value);
    }
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

// ── Test command detection ───────────────────────────────────────────

const TEST_COMMANDS = ["vitest", "jest", "mocha", "pytest", "phpunit", "rspec"];
const LINT_COMMANDS = ["eslint", "prettier", "tsc", "biome", "oxlint"];
const TEST_PM = ["npm", "yarn", "pnpm", "bun"];
const TEST_LANG = ["cargo", "go", "dotnet", "deno"];

function isTestCommand(cmd, args) {
  if (TEST_COMMANDS.includes(cmd)) return true;
  if (LINT_COMMANDS.includes(cmd)) return true;
  if (TEST_PM.includes(cmd) && args[0] === "test") return true;
  if (TEST_PM.includes(cmd) && args[0] === "run" && /^(test|lint)(:|$)/.test(args[1] || "")) return true;
  if (TEST_PM.includes(cmd) && /^(test|lint)(:|$)/.test(args[0] || "")) return true;
  if (TEST_LANG.includes(cmd) && args[0] === "test") return true;
  if (cmd === "node" && args.includes("--test")) return true;
  return false;
}

// ── Message formatting ──────────────────────────────────────────────

function formatMsg(template, vars) {
  let msg = template;
  for (const [k, v] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return msg;
}

function checkRule(rule, cmd, args, fullPath, isInPipe, pipeline, segIdx, rawCommand, redirects, allExes) {
  switch (rule.type) {
    case "banned-command":
      if (!rule.commands.includes(cmd)) return null;
      if (rule.exempt_when && allExes && allExes.has(rule.exempt_when)) return null;
      if (rule.exempt_subcommands && rule.exempt_subcommands.includes(args[0])) return null;
      return formatMsg(rule.message, { cmd });

    case "banned-pipe-target":
      if (!isInPipe) return null;
      if (!rule.commands.includes(cmd)) return null;
      return formatMsg(rule.message, { cmd });

    case "banned-pipe-source":
      if (segIdx !== 0 || pipeline.segments.length <= 1) return null;
      if (!isTestCommand(cmd, args)) return null;
      return rule.message;

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
      if (rule.commands && !rule.commands.includes(cmd)) return null;
      if (rule.test_only && !isTestCommand(cmd, args)) return null;
      if (!rule.flags.some((f) => args.some((a) => a === f || a.startsWith(f + "=")))) return null;
      // For --reporter, allow verbose/full reporters
      if (rule.allow_values) {
        const flagHit = rule.flags.find((f) => args.some((a) => a === f || a.startsWith(f + "=")));
        if (flagHit) {
          const flagArg = args.find((a) => a === flagHit || a.startsWith(flagHit + "="));
          const flagIdx = args.indexOf(flagArg);
          let val = "";
          if (flagArg.includes("=")) val = flagArg.split("=")[1];
          else if (flagIdx + 1 < args.length) val = args[flagIdx + 1];
          if (rule.allow_values.some((av) => val === av)) return null;
        }
      }
      return formatMsg(rule.message, { cmd });

    case "banned-path-pattern": {
      const normalize = (s) => s.replace(/\\/g, "/");
      const pat = rule.pattern;
      if (normalize(fullPath).includes(pat)) return rule.message;
      for (const arg of args) {
        if (normalize(arg).includes(pat)) return rule.message;
      }
      return null;
    }

    case "banned-arg-pattern": {
      const norm = (s) => s.replace(/\\/g, "/");
      const allWords = [fullPath, ...args];
      for (const w of allWords) {
        const nw = norm(w);
        if (nw.includes(rule.pattern) && rule.arg_must_also_match.some((t) => nw.includes(t))) {
          return rule.message;
        }
      }
      return null;
    }

    case "banned-redirect":
      if (!redirects || redirects.length === 0) return null;
      for (const redir of redirects) {
        if (rule.targets.some((t) => redir.target === t)) {
          return rule.message;
        }
      }
      return null;

    case "banned-test-redirect":
      if (!redirects || redirects.length === 0) return null;
      if (!isTestCommand(cmd, args)) return null;
      // Any output redirect on a test command is suppression
      for (const redir of redirects) {
        if (redir.op === ">" || redir.op === ">>" || redir.op === "2>" || redir.op === "2>>") {
          return formatMsg(rule.message, { cmd, target: redir.target });
        }
      }
      return null;

    default:
      return null;
  }
}

function evaluate(rawCommand) {
  const tokens = tokenize(rawCommand);
  const pipelines = buildAST(tokens);
  const wrappers = new Set(CONFIG.wrappers || []);

  // Collect all exe names for AST-aware exempt_when checks
  const allExes = new Set();
  for (const pl of pipelines) {
    for (const seg of pl.segments) {
      const p = parseSegment(seg);
      if (p) allExes.add(p.exe);
    }
  }

  for (const pipeline of pipelines) {
    for (let segIdx = 0; segIdx < pipeline.segments.length; segIdx++) {
      const parsed = parseSegment(pipeline.segments[segIdx]);
      if (!parsed) continue;

      const { exe, full, args } = parsed;
      const isInPipe = segIdx > 0;
      const redirects = pipeline.segments[segIdx].redirects || [];

      for (const rule of CONFIG.rules) {
        const msg = checkRule(rule, exe, args, full, isInPipe, pipeline, segIdx, rawCommand, redirects, allExes);
        if (msg) {
          return { decision: "block", reason: msg, match: { command: full, argv: args } };
        }
      }

      // Recurse into wrapper commands (bash -c, sh -lc, env, exec)
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

      // env/exec prefix — just strips itself and runs the rest
      if (exe === "env" || exe === "exec") {
        let cmdStart = 0;
        for (let ai = 0; ai < args.length; ai++) {
          if (args[ai].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[ai])) continue;
          cmdStart = ai;
          break;
        }
        if (args[cmdStart]) {
          const result = evaluate(args.slice(cmdStart).join(" "));
          if (result) return result;
        }
      }

      // xargs runs its arguments as a command
      if (exe === "xargs" && args.length > 0) {
        // Skip xargs flags, find the command
        let cmdStart = 0;
        for (let ai = 0; ai < args.length; ai++) {
          if (args[ai].startsWith("-")) { if (/^-[nIidlsP]$/.test(args[ai])) ai++; continue; }
          cmdStart = ai;
          break;
        }
        if (args[cmdStart]) {
          const result = evaluate(args.slice(cmdStart).join(" "));
          if (result) return result;
        }
      }
    }
  }

  // Recurse into backtick, $(), and process substitution <() >()
  const backtickRe = /`([^`]+)`/g;
  const dollarParenRe = /\$\(([^)]+)\)/g;
  const procSubRe = /[<>]\(([^)]+)\)/g;
  let subMatch;
  while ((subMatch = backtickRe.exec(rawCommand)) !== null) {
    const result = evaluate(subMatch[1]);
    if (result) return result;
  }
  while ((subMatch = dollarParenRe.exec(rawCommand)) !== null) {
    const result = evaluate(subMatch[1]);
    if (result) return result;
  }
  while ((subMatch = procSubRe.exec(rawCommand)) !== null) {
    const result = evaluate(subMatch[1]);
    if (result) return result;
  }

  return null;
}

// ── Package.json lint/test standards check ──────────────────────────

const ESLINT_CONFIG_FILES = [
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
];

function hasEslintConfigProtection(cwd) {
  for (const name of ESLINT_CONFIG_FILES) {
    try {
      const content = readFileSync(join(cwd, name), "utf8");
      if (content.includes("noInlineConfig")) return true;
    } catch { /* not found */ }
  }
  return false;
}

const LINT_STANDARDS = {
  // script name → { scriptRequires, configAlternative }
  lint: {
    scriptFlags: ["--no-inline-config"],
    configCheck: hasEslintConfigProtection,
  },
};

function checkPackageJsonStandards(cmd, cwd) {
  if (!cwd) return null;

  const tokens = tokenize(cmd);
  const ast = buildAST(tokens);
  if (ast.length === 0) return null;

  // Check ALL pipelines, not just the last one
  for (const pipeline of ast) {
    for (const seg of pipeline.segments) {
      const result = checkSegmentStandards(seg, cwd);
      if (result) return result;
    }
  }
  return null;
}

function checkSegmentStandards(seg, cwd) {
  if (!seg) return null;
  const parsed = parseSegment(seg);
  if (!parsed) return null;

  const { exe, args } = parsed;
  const pms = ["npm", "yarn", "pnpm", "bun"];
  if (!pms.includes(exe)) return null;

  // Determine the script name being run
  let scriptName = null;
  if (args[0] === "run" && args[1]) scriptName = args[1];
  else if (args[0] === "test") scriptName = "test";
  else if (["lint", "build", "start"].includes(args[0])) scriptName = args[0];
  if (!scriptName) return null;

  // Find which standard applies
  let standard = null;
  for (const [pattern, std] of Object.entries(LINT_STANDARDS)) {
    if (scriptName === pattern || scriptName.startsWith(pattern + ":")) {
      standard = std;
      break;
    }
  }
  if (!standard) return null;

  // Check config file first — if protection is there, script flag is optional
  if (standard.configCheck && standard.configCheck(cwd)) return null;

  // Read package.json
  let pkg;
  try {
    const pkgPath = join(cwd, "package.json");
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null; // No package.json or unreadable — don't block
  }

  const scriptValue = pkg.scripts?.[scriptName];
  if (!scriptValue) return null; // Script doesn't exist — don't block here

  // Check each required flag in the script
  const missing = standard.scriptFlags.filter((p) => !scriptValue.includes(p));
  if (missing.length === 0) return null;

  return {
    decision: "block",
    reason: `package.json script "${scriptName}" is missing required config: ${missing.join(", ")}. Either add to your lint script or set noInlineConfig: true in your eslint config file.`,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let parsed;
  try { parsed = JSON.parse(input); } catch { process.exit(0); }
  const cmd = parsed?.tool_input?.command;
  const cwd = parsed?.cwd;
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

  // Check package.json standards for lint/test commands
  const stdResult = checkPackageJsonStandards(cmd, cwd);
  if (stdResult) {
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: stdResult.reason,
      },
    });
    process.stdout.write(output + "\n");
    process.exit(0);
  }

  process.exit(0);
});

// Export for testing
module.exports = { evaluate, checkPackageJsonStandards };
