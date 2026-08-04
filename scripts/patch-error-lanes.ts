/**
 * One-time repair for flows imported before the dialect learned n8n's error
 * outputs. The n8n export said which nodes had onError=continueErrorOutput,
 * but the early importer dropped it. The graph still knows: a non-branching
 * step with an outgoing branch-1 edge can only mean an error lane — IF and
 * Switch are the only types with legitimate multiple outputs.
 *
 * Usage: npx tsx scripts/patch-error-lanes.ts <flow.json> [...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const BRANCHING = new Set(["n8n-nodes-base.if", "n8n-nodes-base.switch"]);

for (const path of process.argv.slice(2)) {
  const flow = JSON.parse(readFileSync(path, "utf8"));
  let stamped = 0;
  for (const node of flow.graph.nodes) {
    if (node.node !== "n8n.step") continue;
    if (BRANCHING.has(String(node.params.type))) continue;
    const hasErrorLane = flow.graph.edges.some(
      (e: { from: string; branch?: number }) => e.from === node.id && (e.branch ?? 0) >= 1,
    );
    if (hasErrorLane && node.params.__errorOutput !== true) {
      node.params.__errorOutput = true;
      stamped++;
    }
  }
  writeFileSync(path, JSON.stringify(flow, null, 2));
  console.log(`${path}: ${stamped} error lane(s) stamped`);
}
