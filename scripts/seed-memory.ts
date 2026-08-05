/**
 * One-off: seed a memory directly through the real SemanticMemory class,
 * so the format (slug, meta, trailing newline) matches exactly what the
 * agent itself writes.
 *
 * Usage: npx tsx scripts/seed-memory.ts <tenant-memory-dir> <name> <content>
 */
import { SemanticMemory } from "../packages/memory/src/index.js";

const [dir, name, content] = process.argv.slice(2);
const m = new SemanticMemory(dir);
const slug = m.remember(name, content);
console.log(`remembered as "${slug}"`);
console.log("recall test:", m.recall("ssh again").map((x) => x.name));
