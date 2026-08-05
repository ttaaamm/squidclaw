/**
 * Live proof: does the real deployed memory, through the real embedding
 * server, find the SSH memory from a paraphrase with ZERO shared words?
 * Usage: npx tsx scripts/verify-vector-recall.ts <tenant-memory-dir> <embed-url>
 */
import { SemanticMemory, embedViaServer } from "../packages/memory/src/index.js";

const [dir, embedUrl] = process.argv.slice(2);
const memory = new SemanticMemory(dir, { embed: embedViaServer(embedUrl) });

const queries = ["how do I get onto my box", "reach the server we connected to before", "ssh again"];
for (const q of queries) {
  const hits = await memory.recall(q, { limit: 3 });
  console.log(`"${q}" ->`, hits.map((h) => h.name));
}
