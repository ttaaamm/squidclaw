import type { Graph } from "@squidclaw/kernel";

export interface LaidOutNode {
  id: string;
  node: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Depth from the graph's roots — the column it sits in. */
  rank: number;
}

export interface LaidOutEdge {
  from: string;
  to: string;
  path: string;
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

const NODE_W = 190;
const NODE_H = 64;
const GAP_X = 90;
const GAP_Y = 28;
const PAD = 40;

/**
 * Ranks each node by how far it sits from a root, then stacks same-rank nodes
 * in a column. Left to right, because that's how the work reads.
 *
 * Cycles can't occur in a recorded execution, but a hand-edited flow could
 * contain one — so unreachable nodes are placed rather than dropped.
 */
export function rankNodes(graph: Graph): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) incoming.get(e.to)?.push(e.from);

  const rank = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map(depth)) + 1 : 0;
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };

  for (const n of graph.nodes) depth(n.id);
  return rank;
}

/** Cubic bezier that leaves the right edge and arrives at the left edge. */
function edgePath(from: LaidOutNode, to: LaidOutNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function layoutGraph(graph: Graph): Layout {
  const rank = rankNodes(graph);

  const columns = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const r = rank.get(n.id) ?? 0;
    columns.set(r, [...(columns.get(r) ?? []), n.id]);
  }

  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y;

  const placed = new Map<string, LaidOutNode>();
  for (const [r, ids] of columns) {
    const columnHeight = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
    const top = (height - columnHeight) / 2;
    ids.forEach((id, i) => {
      const node = graph.nodes.find((n) => n.id === id)!;
      placed.set(id, {
        id,
        node: node.node,
        rank: r,
        x: PAD + r * (NODE_W + GAP_X),
        y: top + i * (NODE_H + GAP_Y),
        width: NODE_W,
        height: NODE_H,
      });
    });
  }

  const widest = Math.max(0, ...[...rank.values()]);
  const edges: LaidOutEdge[] = graph.edges
    .filter((e) => placed.has(e.from) && placed.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, path: edgePath(placed.get(e.from)!, placed.get(e.to)!) }));

  return {
    nodes: [...placed.values()],
    edges,
    width: PAD * 2 + (widest + 1) * NODE_W + widest * GAP_X,
    height,
  };
}
