/**
 * In-run compaction: a long task must not drown in its own history.
 *
 * As the classic loop works, every tool round appends an assistant
 * (tool_use) + user (tool_result) pair. Forty rounds of that and the run
 * balloons — slow, expensive, and eventually confused. When the running
 * transcript outgrows its budget, the OLDEST completed pairs fold into one
 * compact note.
 *
 * The cardinal rule (the trap every naive compactor falls into): a
 * tool_use and its tool_result are one atom. Pairs fold whole or not at
 * all, and the most recent pair never folds — the model may still be
 * reasoning against it.
 */

interface Msg {
  role: string;
  content: unknown;
}

interface Block {
  type?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

const blocksOf = (m: Msg): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : []);
const isToolUse = (m: Msg) => m.role === "assistant" && blocksOf(m).some((b) => b.type === "tool_use");
const isToolResult = (m: Msg) => m.role === "user" && blocksOf(m).some((b) => b.type === "tool_result");

const clip = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "" : s.length > n ? `${s.slice(0, n)}…` : s;
};

/** One folded pair becomes one plain line: what was called, what came back. */
function summarizePair(use: Msg, result: Msg): string {
  const calls = blocksOf(use)
    .filter((b) => b.type === "tool_use")
    .map((b) => `${b.name}(${clip(b.input, 80)})`)
    .join(", ");
  const results = blocksOf(result)
    .filter((b) => b.type === "tool_result")
    .map((b) => clip(b.content, 160))
    .join(" | ");
  return `- ${calls} → ${results}`;
}

export const runSize = (messages: unknown[]): number => JSON.stringify(messages).length;

/**
 * Returns a transcript within budget, or as close as folding allows.
 * Untouched when already small — compaction must never cost a fast run
 * anything.
 */
export function compactRun(messages: unknown[], budgetChars: number): unknown[] {
  if (runSize(messages) <= budgetChars) return messages;

  const msgs = messages as Msg[];
  // Completed pairs: assistant tool_use immediately followed by its results.
  const pairs: Array<{ use: number; result: number }> = [];
  for (let i = 0; i < msgs.length - 1; i++) {
    if (isToolUse(msgs[i]) && isToolResult(msgs[i + 1])) pairs.push({ use: i, result: i + 1 });
  }
  // The newest pair is live context — never foldable.
  const foldable = pairs.slice(0, -1);
  if (!foldable.length) return messages;

  const folded = new Set<number>();
  const notes: string[] = [];
  for (const pair of foldable) {
    notes.push(summarizePair(msgs[pair.use], msgs[pair.result]));
    folded.add(pair.use);
    folded.add(pair.result);
    // Estimate: what remains if we stopped folding here.
    const remaining = msgs.filter((_, i) => !folded.has(i));
    if (runSize(remaining) + notes.join("\n").length <= budgetChars) break;
  }

  const note: Msg = {
    role: "user",
    content: `[earlier work in this task, compacted to stay fast]\n${notes.join("\n")}`,
  };
  const firstFolded = Math.min(...folded);
  const out: unknown[] = [];
  msgs.forEach((m, i) => {
    if (i === firstFolded) out.push(note);
    if (!folded.has(i)) out.push(m);
  });
  return out;
}
