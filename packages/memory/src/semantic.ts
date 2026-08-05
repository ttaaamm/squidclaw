import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cosineSimilarity, type Embedder } from "./embeddings.js";

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

export interface SemanticMemoryOptions {
  /**
   * True vector memory: a local embedding model (no API — see
   * scripts/install-vectors.sh). Two texts with zero shared words but the
   * same MEANING still find each other. Absent, recall stays lexical-only
   * — still correct, just word-bound.
   */
  embed?: Embedder;
  /** How much weight semantic similarity carries vs word overlap, 0..1. */
  semanticWeight?: number;
  /** Below this cosine similarity, a semantic-only match (no shared words) is noise, not a hit. */
  semanticFloor?: number;
}

/**
 * Semantic memory: what it knows.
 *
 * Plain markdown files on disk — greppable, git-diffable, human-editable.
 * An agent whose mind you can read is an agent you can trust.
 */
export class SemanticMemory {
  private metaPath: string;
  private vectorsPath: string;
  private embed?: Embedder;
  private semanticWeight: number;
  private semanticFloor: number;

  constructor(
    private dir: string,
    opts: SemanticMemoryOptions = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.metaPath = join(dir, ".meta.json");
    this.vectorsPath = join(dir, ".vectors.json");
    this.embed = opts.embed;
    this.semanticWeight = opts.semanticWeight ?? 0.55;
    this.semanticFloor = opts.semanticFloor ?? 0.5;
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

  private vectors(): Record<string, number[]> {
    if (!existsSync(this.vectorsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.vectorsPath, "utf8")) as Record<string, number[]>;
    } catch {
      return {};
    }
  }

  private writeVectors(v: Record<string, number[]>): void {
    writeFileSync(this.vectorsPath, JSON.stringify(v), "utf8");
  }

  remember(name: string, content: string): string {
    const slug = slugify(name);
    writeFileSync(join(this.dir, `${slug}.md`), content.endsWith("\n") ? content : `${content}\n`, "utf8");
    const meta = this.meta();
    meta[slug] = { ...(meta[slug] ?? { createdAt: new Date().toISOString() }) };
    this.writeMeta(meta);
    // The content changed (or is new) — its cached vector, if any, is stale.
    const vecs = this.vectors();
    if (slug in vecs) {
      delete vecs[slug];
      this.writeVectors(vecs);
    }
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

  private tokenize(s: string): string[] {
    return s.toLowerCase().match(/[a-z0-9]+|[؀-ۿ]+/g)?.filter((t) => !STOPWORDS.has(t) && t.length > 1) ?? [];
  }

  /** Word-overlap score per memory, TF-IDF weighted with partial-match credit. */
  private lexicalScores(memories: Memory[], queryTokens: string[]): Map<string, number> {
    const docTokens = memories.map((m) => this.tokenize(`${m.name} ${m.content}`));
    const df = new Map<string, number>();
    for (const tokens of docTokens) {
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const idf = (t: string) => Math.log(1 + memories.length / (df.get(t) ?? 1));

    const scores = new Map<string, number>();
    memories.forEach((m, i) => {
      const tokens = docTokens[i];
      let score = 0;
      for (const qt of queryTokens) {
        const exact = tokens.filter((t) => t === qt).length;
        if (exact) { score += exact * idf(qt); continue; }
        if (tokens.some((t) => t.length > 2 && qt.length > 2 && (t.includes(qt) || qt.includes(t)))) {
          score += idf(qt) * 0.4;
        }
      }
      if (score > 0) scores.set(m.name, score);
    });
    return scores;
  }

  /** Every current memory gets a cached embedding; only what's missing is computed. Never throws. */
  private async ensureVectors(memories: Memory[]): Promise<Record<string, number[]>> {
    if (!this.embed) return {};
    const vecs = this.vectors();
    let changed = false;
    for (const m of memories) {
      if (vecs[m.name]) continue;
      try {
        vecs[m.name] = await this.embed(`${m.name}: ${m.content}`);
        changed = true;
      } catch {
        // this one memory just sits out semantic scoring until a later attempt succeeds
      }
    }
    if (changed) this.writeVectors(vecs);
    return vecs;
  }

  /**
   * Relevance search — words AND meaning.
   *
   * Lexical (TF-IDF over shared words) always runs — zero dependencies,
   * catches "ssh" ↔ "sshd". When an embedder is configured, semantic
   * similarity blends in — catches "reach my box" ↔ "SSH access works"
   * even with not one word in common. A stumbling embedder degrades
   * silently to lexical-only; recall must never throw.
   */
  async recall(query: string, opts: { limit?: number } = {}): Promise<Memory[]> {
    const memories = this.all();
    if (!memories.length) return [];

    const queryTokens = this.tokenize(query);
    // A query too short or made entirely of stopwords still deserves an
    // honest attempt — plain substring, no scoring machinery warranted.
    if (!queryTokens.length) {
      const q = query.toLowerCase().trim();
      const hits = q ? memories.filter((m) => m.name.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)) : [];
      this.touch(hits.map((m) => m.name));
      return hits.slice(0, opts.limit);
    }

    const lexical = this.lexicalScores(memories, queryTokens);
    const maxLex = Math.max(1e-9, ...[...lexical.values()]);

    let semantic = new Map<string, number>();
    if (this.embed) {
      try {
        const vecs = await this.ensureVectors(memories);
        const qVec = await this.embed(query);
        for (const m of memories) {
          const v = vecs[m.name];
          if (v) semantic.set(m.name, cosineSimilarity(qVec, v));
        }
      } catch {
        semantic = new Map(); // the embedder stumbled this round — lexical carries it alone
      }
    }

    const scored = memories.map((m) => {
      const lex = (lexical.get(m.name) ?? 0) / maxLex; // normalized 0..1
      const sem = Math.max(0, semantic.get(m.name) ?? 0);
      const hasLexical = lexical.has(m.name);
      const combined = this.embed ? (1 - this.semanticWeight) * lex + this.semanticWeight * sem : lex;
      // A pure-semantic match (no shared words at all) must clear a real
      // similarity bar before it counts — otherwise every memory would
      // sneak in on embedding noise alone.
      const qualifies = hasLexical || sem >= this.semanticFloor;
      return { m, score: qualifies ? combined : 0 };
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
    const slug = slugify(name);
    try {
      rmSync(join(this.dir, `${slug}.md`));
      const vecs = this.vectors();
      if (slug in vecs) {
        delete vecs[slug];
        this.writeVectors(vecs);
      }
      return true;
    } catch {
      return false;
    }
  }
}
