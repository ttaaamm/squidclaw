/**
 * Teach the formal-post template's body to shrink-to-fit, like its title
 * always could. The original design fixed body type at 42px and trusted
 * word-count ceilings measured upstream — production proved those ceilings
 * miscalibrated (21 words + a two-line headline = last line sliced in half).
 * A gentle shrink floored at 32px absorbs the variance; the upstream trim
 * remains as the backstop for genuinely overlong copy.
 *
 * Exact-string replacement with validation — no regex, no sed, no surprises.
 *
 * Usage: npx tsx scripts/patch-template-bodyfit.ts <template.html> [...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const ANCHOR = "  fit(title, 66, 34);";
const PATCHED = `  fit(title, 66, 34);
  // The body shrinks too — gently. 42px is still the target; the floor keeps
  // it far from caption territory while absorbing what the word ceilings
  // miss (a two-line headline stealing a line's worth of body space).
  fit(document.getElementById('body'), 42, 32);`;

for (const path of process.argv.slice(2)) {
  const html = readFileSync(path, "utf8");
  if (html.includes("fit(document.getElementById('body')")) {
    console.log(`${path}: already patched`);
    continue;
  }
  if (!html.includes(ANCHOR)) {
    console.error(`${path}: anchor not found — refusing to touch it`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(path, html.replace(ANCHOR, PATCHED));
  console.log(`${path}: body auto-fit added`);
}
