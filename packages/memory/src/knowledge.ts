import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NodeDef } from "@squidclaw/kernel";

export interface Chunk {
  docId: string;
  source: string;
  index: number;
  text: string;
}

export interface KnowledgeDoc {
  id: string;
  source: string;
  addedAt: string;
  chunks: number;
}

/** ~800-char chunks with overlap, split on paragraph edges where possible. */
export function chunkText(text: string, size = 800, overlap = 120): string[] {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Prefer to break at a paragraph, then a sentence, inside the last stretch.
      const slice = clean.slice(start, end);
      const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
      if (cut > size * 0.5) end = start + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks.filter(Boolean);
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

/**
 * The library: documents chunked and searchable.
 *
 * Ranking is TF-IDF cosine — pure arithmetic, no API key, no model, works
 * identically on every machine. An embeddings upgrade can slot in behind the
 * same search() signature when a key exists; the default must never need one.
 */
export class KnowledgeBase {
  private indexPath: string;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.indexPath = join(dir, "index.json");
  }

  private read(): { docs: KnowledgeDoc[]; chunks: Chunk[] } {
    if (!existsSync(this.indexPath)) return { docs: [], chunks: [] };
    return JSON.parse(readFileSync(this.indexPath, "utf8")) as { docs: KnowledgeDoc[]; chunks: Chunk[] };
  }

  private write(data: { docs: KnowledgeDoc[]; chunks: Chunk[] }): void {
    writeFileSync(this.indexPath, JSON.stringify(data), "utf8");
  }

  add(source: string, text: string): KnowledgeDoc {
    const data = this.read();
    // Re-ingesting a source replaces it — a newer version of a doc supersedes.
    data.chunks = data.chunks.filter((c) => c.source !== source);
    data.docs = data.docs.filter((d) => d.source !== source);

    const id = randomUUID().slice(0, 8);
    const pieces = chunkText(text);
    pieces.forEach((piece, index) => data.chunks.push({ docId: id, source, index, text: piece }));
    const doc: KnowledgeDoc = { id, source, addedAt: new Date().toISOString(), chunks: pieces.length };
    data.docs.push(doc);
    this.write(data);
    return doc;
  }

  docs(): KnowledgeDoc[] {
    return this.read().docs;
  }

  search(query: string, k = 4): Array<Chunk & { score: number }> {
    const { chunks } = this.read();
    if (!chunks.length) return [];

    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    // Document frequency over chunks.
    const df = new Map<string, number>();
    const chunkTokens = chunks.map((c) => {
      const tokens = tokenize(c.text);
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
      return tokens;
    });
    const idf = (t: string) => Math.log(1 + chunks.length / (1 + (df.get(t) ?? 0)));

    const scored = chunks.map((chunk, i) => {
      const tokens = chunkTokens[i];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let dot = 0;
      let norm = 0;
      for (const [t, f] of tf) {
        const w = (f / tokens.length) * idf(t);
        norm += w * w;
      }
      for (const qt of new Set(queryTokens)) {
        const f = tf.get(qt);
        if (f) dot += (f / tokens.length) * idf(qt) * idf(qt);
      }
      const score = norm ? dot / Math.sqrt(norm) : 0;
      return { ...chunk, score };
    });

    return scored
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  remove(source: string): boolean {
    const data = this.read();
    const before = data.docs.length;
    data.docs = data.docs.filter((d) => d.source !== source);
    data.chunks = data.chunks.filter((c) => c.source !== source);
    this.write(data);
    return data.docs.length < before;
  }
}

/** Reads a file into text — injected, so the memory package never execs anything. */
export type TextExtractor = (path: string) => Promise<string>;

export function knowledgeNodes(kb: KnowledgeBase, extract: TextExtractor): NodeDef[] {
  return [
    {
      name: "knowledge.ingest",
      description:
        "Add a document to the knowledge base so its contents can be searched later. Params: path (a file on disk — txt, md, csv, json, or pdf), source (optional friendly name). Use when the human sends a file worth keeping.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, source: { type: "string" } },
      },
      run: async (params) => {
        const path = String(params.path);
        const text = await extract(path);
        if (!text.trim()) throw new Error(`knowledge.ingest: nothing readable in ${path}`);
        const doc = kb.add(String(params.source ?? path.split(/[\\/]/).at(-1)), text);
        return [{ json: { ingested: true, source: doc.source, chunks: doc.chunks } }];
      },
    },
    {
      name: "knowledge.search",
      description:
        "Search everything in the knowledge base (ingested documents). Params: query (required), k (how many passages, default 4). Returns the most relevant passages with their sources.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, k: { type: "number" } },
      },
      run: async (params) => {
        const hits = kb.search(String(params.query), (params.k as number) ?? 4);
        return hits.length
          ? hits.map((h) => ({ json: { source: h.source, passage: h.text, score: Number(h.score.toFixed(4)) } }))
          : [{ json: { found: false, note: "nothing relevant in the knowledge base" } }];
      },
    },
    {
      name: "knowledge.list",
      description: "List the documents in the knowledge base. No params.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const docs = kb.docs();
        return docs.length
          ? docs.map((d) => ({ json: { source: d.source, chunks: d.chunks, addedAt: d.addedAt } }))
          : [{ json: { empty: true } }];
      },
    },
  ];
}
