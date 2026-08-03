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

  /** Substring match over name and body — small corpora don't need embeddings. */
  recall(query: string): Memory[] {
    const q = query.toLowerCase();
    const hits = this.all().filter((m) => m.name.toLowerCase().includes(q) || m.content.toLowerCase().includes(q));
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
