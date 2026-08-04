/**
 * Fires flow.post exactly as the agent's tool call would — renderGraph fills
 * the params, executeGraph runs the pipeline — and the finished card lands in
 * the REAL chat. The proof is the delivery.
 *
 * Usage: npx tsx scripts/test-native-post.ts <post.flow.json> "<title>" "<topic>" [size]
 */
import { readFileSync } from "node:fs";
import { executeGraph, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { renderGraph } from "@squidclaw/agent";

async function main() {
  const [path, title, topic, size] = process.argv.slice(2);
  registerBuiltinNodes();
  const flow = JSON.parse(readFileSync(path, "utf8"));

  const rec = await executeGraph(renderGraph(flow.graph, { title, topic, size: size ?? "post" }), {
    tenantId: "65ed2cc7", kind: "flow", journal: new Journal(":memory:"),
  });

  console.log(`run=${rec.status}`);
  for (const s of rec.steps) {
    if (s.status === "skipped") continue;
    const name = (s.params as any).n8nName ?? s.nodeId;
    console.log(`  ${name}: ${s.status}${s.error ? `  !! ${String(s.error).slice(0, 180)}` : ""}`);
  }
}

main();
