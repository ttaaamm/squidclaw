import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface Memory {
  name: string;
  content: string;
}

interface MemoryMeta {
  createdAt: string;
  lastRecalledAt?: string;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "to", "of", "and", "or", "in", "on", "at",
  "for", "with", "my", "your", "his", "her", "it", "its", "this", "that", "again", "please",
  "من", "في", "على", "إلى", "هو", "هي", "أن", "لا", "ما",
]);

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’`]/g, "") // possessives shouldn't split words: "Tamer's" -> "tamers"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

/**
 * Semantic memory: what it knows.
 *
 * Plain markdown files on disk — greppable, git-diffable, human-editable.
 * An agent whose mind you can read is an agent you can trust.
 */
export class SemanticMemory {
  private metaPath: string;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.metaPath = join(dir, ".meta.json");
  }

  private meta(): Record<string, MemoryMeta> {
    if (!existsSync(this.metaPath)) return {};
    return JSON.parse(readFileSync(this.metaPath, "utf8")) as Record<string, MemoryMeta>;
  }

  private writeMeta(meta: Record<string, MemoryMeta>): void {
    writeFileSync(this.metaPath, JSON.stringify(meta), "utf8");
  }

  private touch(names: string[]): void {
    if (!names.length) return;
    const meta = this.meta();
    const now = new Date().toISOString();
    for (const name of names) meta[name] = { ...(meta[name] ?? { createdAt: now }), lastRecalledAt: now };
    this.writeMeta(meta);
  }

  remember(name: string, content: string): string {
    const slug = slugify(name);
    writeFileSync(join(this.dir, `${slug}.md`), content.endsWith("\n") ? content : `${content}\n`, "utf8");
    const meta = this.meta();
    meta[slug] = { ...(meta[slug] ?? { createdAt: new Date().toISOString() }) };
    this.writeMeta(meta);
    return slug;
  }

  /**
   * Decay: memories neither recalled nor written for a while retire to
   * _archive/ — recoverable, but no longer carried in every prompt.
   * Some names are load-bearing and never decay.
   */
  decay(opts: { maxAgeDays?: number; protect?: string[] } = {}): string[] {
    const maxAgeMs = (opts.maxAgeDays ?? 30) * 86_400_000;
    const protectList = new Set(opts.protect ?? []);
    const meta = this.meta();
    const now = Date.now();
    const archiveDir = join(this.dir, "_archive");
    const retired: string[] = [];

    for (const memory of this.all()) {
      if (protectList.has(memory.name)) continue;
      const m = meta[memory.name];
      const lastAlive = Date.parse(m?.lastRecalledAt ?? m?.createdAt ?? new Date().toISOString());
      if (now - lastAlive < maxAgeMs) continue;
      mkdirSync(archiveDir, { recursive: true });
      renameSync(join(this.dir, `${memory.name}.md`), join(archiveDir, `${memory.name}.md`));
      delete meta[memory.name];
      retired.push(memory.name);
    }
    if (retired.length) this.writeMeta(meta);
    return retired;
  }

  all(): Memory[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f.replace(/\.md$/, ""), content: readFileSync(join(this.dir, f), "utf8").trim() }));
  }

  /**
   * Relevance search — no API, no embeddings, no network: TF-IDF scoring
   * over the on-disk corpus. A plain substring match missed "ssh again"
   * against a memory that says "SSH access to 76.13.49.186 works" — this
   * scores by shared WORDS, weighted by how rare each word is across
   * everything remembered, plus partial credit for near-matches (ssh ↔
   * sshd). Good enough at hundreds of memories; this is a mind's notes,
   * not a search engine's index.
   */
  recall(query: string, opts: { limit?: number } = {}): Memory[] {
    const memories = this.all();
    if (!memories.length) return [];

    const tokenize = (s: string): string[] =>
      s.toLowerCase().match(/[a-z0-9]+|[؀-ۿ]+/g)?.filter((t) => !STOPWORDS.has(t) && t.length > 1) ?? [];

    const docTokens = memories.map((m) => tokenize(`${m.name} ${m.content}`));
    const df = new Map<string, number>();
    for (const tokens of docTokens) {
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const idf = (t: string) => Math.log(1 + memories.length / (df.get(t) ?? 1));

    const queryTokens = tokenize(query);
    // A query too short or made entirely of stopwords still deserves an
    // honest attempt — fall back to the raw substring behavior for it.
    if (!queryTokens.length) {
      const q = query.toLowerCase().trim();
      const hits = q ? memories.filter((m) => m.name.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)) : [];
      this.touch(hits.map((m) => m.name));
      return hits.slice(0, opts.limit);
    }

    const scored = memories.map((m, i) => {
      const tokens = docTokens[i];
      let score = 0;
      for (const qt of queryTokens) {
        const exact = tokens.filter((t) => t === qt).length;
        if (exact) { score += exact * idf(qt); continue; }
        // Partial credit: "ssh" inside "sshd", "server" inside "servers".
        if (tokens.some((t) => t.length > 2 && qt.length > 2 && (t.includes(qt) || qt.includes(t)))) {
          score += idf(qt) * 0.4;
        }
      }
      return { m, score };
    });

    const hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
      .map((s) => s.m);
    this.touch(hits.map((m) => m.name)); // being recalled is what keeps a memory alive
    return hits;
  }

  forget(name: string): boolean {
    try {
      rmSync(join(this.dir, `${slugify(name)}.md`));
      return true;
    } catch {
      return false;
    }
  }
}
