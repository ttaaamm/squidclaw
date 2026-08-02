import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface Memory {
  name: string;
  content: string;
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
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  remember(name: string, content: string): string {
    const slug = slugify(name);
    writeFileSync(join(this.dir, `${slug}.md`), content.endsWith("\n") ? content : `${content}\n`, "utf8");
    return slug;
  }

  all(): Memory[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f.replace(/\.md$/, ""), content: readFileSync(join(this.dir, f), "utf8").trim() }));
  }

  /** Substring match over name and body — small corpora don't need embeddings. */
  recall(query: string): Memory[] {
    const q = query.toLowerCase();
    return this.all().filter((m) => m.name.toLowerCase().includes(q) || m.content.toLowerCase().includes(q));
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
