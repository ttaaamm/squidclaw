#!/usr/bin/env node
/**
 * The secret gate. Feraasa once shipped live Stripe keys into git history —
 * a lesson that only needs learning once. This scans for credential shapes:
 *
 *   --staged  (default) the lines a commit is about to add — the pre-commit hook
 *   --all     every tracked text file — CI's full sweep, so a bypassed hook
 *             still cannot land a secret on main
 *
 * Exit 1 with file/line/pattern when something looks like a key. If it's a
 * false positive, rewrite the line so it stops looking like one — allowlists
 * rot; honest-looking strings don't.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { name: "OpenAI-style key", re: /sk-[A-Za-z0-9]{32,}/ },
  { name: "Stripe LIVE key", re: /[sr]k_live_[A-Za-z0-9]{20,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "GitHub fine-grained token", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SKIP = /\.(png|jpe?g|gif|webp|pdf|otf|ttf|woff2?|ico|zip|db)$/i;

const findings = [];

function scanLine(file, lineNo, line) {
  for (const { name, re } of PATTERNS) {
    if (re.test(line)) findings.push({ file, lineNo, name });
  }
}

if (process.argv.includes("--all")) {
  const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of files) {
    if (SKIP.test(file) || file === "package-lock.json") continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => scanLine(file, i + 1, line));
  }
} else {
  // Staged additions only — the hook must never block on code you didn't touch.
  const diff = execSync("git diff --cached -U0", { encoding: "utf8" });
  let file = "?";
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) { file = raw.slice(6); continue; }
    const hunk = raw.match(/^@@ .* \+(\d+)/);
    if (hunk) { lineNo = Number(hunk[1]) - 1; continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lineNo++;
      if (!SKIP.test(file)) scanLine(file, lineNo, raw.slice(1));
    } else if (!raw.startsWith("-")) {
      lineNo++;
    }
  }
}

if (findings.length) {
  console.error("⛔ possible secrets — commit refused:\n");
  for (const f of findings) console.error(`  ${f.file}:${f.lineNo}  looks like: ${f.name}`);
  console.error("\nIf real: move it to .env / the server's key store and rotate it NOW —");
  console.error("git remembers forever. If a false positive: rewrite the line so it stops");
  console.error("looking like a credential.");
  process.exit(1);
}
console.log("✅ no secret shapes found");
