import { getNode } from "./registry.js";
import { branchesOf, type ExecutionKind, type ExecutionRecord, type Graph, type Item } from "./types.js";
import type { Journal } from "./journal.js";

function topoSort(graph: Graph): string[] {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges.filter((e) => e.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== graph.nodes.length) throw new Error("Graph has a cycle");
  return order;
}

/**
 * Walks a graph in dependency order, flowing items along edges.
 * Sequential for now; the DAG already encodes what may later run in parallel.
 */
export async function executeGraph(
  graph: Graph,
  opts: { tenantId: string; kind?: ExecutionKind; journal: Journal; seedItems?: Item[] },
): Promise<ExecutionRecord> {
  const execId = opts.journal.begin({ tenantId: opts.tenantId, kind: opts.kind ?? "flow", graph });
  // Every node's result as branches: plain Item[] is one branch, branch 0.
  const outputs = new Map<string, Item[][]>();
  const nodeIds = new Map<string, string>();
  for (const n of graph.nodes) {
    const name = (n.params?.n8nName as string) ?? n.id;
    nodeIds.set(name, n.id);
  }
  let failed = false;

  for (const nodeId of topoSort(graph)) {
    const gn = graph.nodes.find((n) => n.id === nodeId)!;
    const def = getNode(gn.node);
    const incoming = graph.edges.filter((e) => e.to === nodeId);
    const input = incoming.length
      ? incoming.flatMap((e) => outputs.get(e.from)?.[e.branch ?? 0] ?? [])
      : (opts.seedItems ?? []);
    const startedAt = new Date().toISOString();
    try {
      if (!def) throw new Error(`Unknown node type: ${gn.node}`);
      const result = await def.run(gn.params, input, {
        tenantId: opts.tenantId,
        outputs,
        nodeIds,
      });
      const branches = branchesOf(result) ?? [result];
      outputs.set(nodeId, branches);
      opts.journal.recordStep(execId, {
        nodeId, node: gn.node, params: gn.params, input, output: result,
        status: "ok", startedAt, finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      opts.journal.recordStep(execId, {
        nodeId, node: gn.node, params: gn.params, input, output: [],
        status: "error", error: String(err), startedAt, finishedAt: new Date().toISOString(),
      });
      failed = true;
      break;
    }
  }

  opts.journal.finish(execId, failed ? "error" : "ok");
  return opts.journal.get(execId)!;
}
