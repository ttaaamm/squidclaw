import { appendFileSync } from "node:fs";
import type { Mind } from "@squidclaw/brains";

/**
 * Dreaming — background memory consolidation, OpenClaw's idea grown here.
 *
 * The passive ear writes memories all day; nobody tends the garden. Once a
 * day, while nothing else is happening, the agent sleeps on it:
 *
 *   light sleep — mechanical: identical memories collapse to one.
 *   deep sleep  — the cheap brain reads the pile and proposes careful
 *                 consolidations: fragments about the same thing merge into
 *                 one clean fact, dead trivia is let go. Capped, protected,
 *                 and never about who the human is.
 *   REM         — every change is written to the Dream Diary (DREAMS.md),
 *                 so the night's work is reviewable, never mysterious.
 *
 * A failed dream is a dreamless night, never an error.
 */

interface MemoryLike {
  name: string;
  content: string;
}

interface MemoryStore {
  all(): MemoryLike[];
  remember(name: string, content: string): string;
  forget(name: string): boolean;
}

export interface DreamReport {
  collapsed: number;
  merged: number;
  forgotten: number;
  kept: number;
}

export interface DreamOptions {
  /** Names that must survive every night. */
  protect?: string[];
  /** Don't bother dreaming over a mind this small. */
  minMemories?: number;
  /** At most this many merges and this many forgets per night. */
  maxOps?: number;
}

const DREAM_HINT =
  "You are consolidating an agent's long-term memory during sleep. Given the memory list, reply ONLY JSON: " +
  '{"merges":[{"name":"kebab-slug","content":"one clean merged fact","replaces":["old-name-1","old-name-2"]}],' +
  '"forget":["name-of-junk-memory"]}. ' +
  "Merge only entries clearly about the SAME thing; forget only trivia, small talk, or obsolete fragments. " +
  'Preserve everything about who the human is, their rules, and their projects. Nothing worth doing? {"merges":[],"forget":[]}.';

export async function dream(
  memory: MemoryStore,
  mind: Mind,
  diaryPath: string,
  opts: DreamOptions = {},
): Promise<DreamReport | undefined> {
  try {
    const protect = new Set(opts.protect ?? []);
    const maxOps = opts.maxOps ?? 5;
    if (memory.all().length < (opts.minMemories ?? 8)) return undefined;

    // Light sleep: identical content collapses to the first copy.
    let collapsed = 0;
    const seen = new Set<string>();
    for (const m of memory.all()) {
      const key = m.content.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key) && !protect.has(m.name)) {
        memory.forget(m.name);
        collapsed++;
      } else {
        seen.add(key);
      }
    }

    // Deep sleep: the cheap brain proposes consolidations.
    const names = new Set(memory.all().map((m) => m.name));
    const listing = memory.all()
      .map((m) => `- ${m.name}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`)
      .join("\n");
    const res = await mind.complete({
      tier: "cheap",
      system: DREAM_HINT,
      messages: [{ role: "user", content: listing }],
      maxTokens: 700,
    });
    const start = res.text.indexOf("{");
    const end = res.text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    const ops = JSON.parse(res.text.slice(start, end + 1)) as {
      merges?: Array<{ name?: string; content?: string; replaces?: string[] }>;
      forget?: string[];
    };

    const diary: string[] = [];
    if (collapsed) diary.push(`- collapsed ${collapsed} duplicate ${collapsed === 1 ? "memory" : "memories"}`);

    let merged = 0;
    for (const m of (ops.merges ?? []).slice(0, maxOps)) {
      if (!m?.name || !m?.content) continue;
      const replaces = (m.replaces ?? []).filter((r) => names.has(r) && !protect.has(r));
      if (!replaces.length) continue;
      memory.remember(m.name, m.content);
      for (const r of replaces) if (r !== m.name) memory.forget(r);
      merged++;
      diary.push(`- merged ${replaces.join(" + ")} → ${m.name}`);
    }

    let forgotten = 0;
    for (const name of (ops.forget ?? []).slice(0, maxOps)) {
      if (!names.has(name) || protect.has(name)) continue;
      if (memory.forget(name)) {
        forgotten++;
        diary.push(`- let go of ${name}`);
      }
    }

    const kept = memory.all().length;
    if (diary.length) {
      appendFileSync(
        diaryPath,
        `\n## ${new Date().toISOString().slice(0, 10)} — slept on ${kept + forgotten + collapsed} memories\n${diary.join("\n")}\n`,
        "utf8",
      );
    }
    return { collapsed, merged, forgotten, kept };
  } catch {
    return undefined; // a dreamless night, never an error
  }
}
