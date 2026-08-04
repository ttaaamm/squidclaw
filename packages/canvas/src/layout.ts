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

/** Cells hold neuron orbs now: orb on top, name + status beneath. */
const NODE_W = 150;
const NODE_H = 98;
const GAP_X = 70;
const GAP_Y = 30;
const PAD = 40;
/** Orb center sits this far below the cell top; edges anchor to the orb rim. */
export const ORB_CY = 30;
export const ORB_R = 22;

/** Deterministic wobble from ids — organic curves that never jiggle on reload. */
function wobble(a: string, b: string): number {
  let h = 0;
  for (const c of a + b) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h % 29) - 14;
}

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

/** An organic dendrite: leaves one orb's rim, curves, arrives at the next. */
function edgePath(from: LaidOutNode, to: LaidOutNode): string {
  const x1 = from.x + from.width / 2 + ORB_R;
  const y1 = from.y + ORB_CY;
  const x2 = to.x + to.width / 2 - ORB_R;
  const y2 = to.y + ORB_CY;
  const dx = Math.max(36, (x2 - x1) / 2);
  const w = wobble(from.id, to.id);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1 + w}, ${x2 - dx} ${y2 - w}, ${x2} ${y2}`;
}

/**
 * Zooming into a neuron: the roots are the nucleus at the center, and each
 * rank of execution spirals outward on widening shells — dendrites branching
 * from the cell body, not a left-to-right org chart. Outer shells compress
 * (sqrt-ish growth) so a 29-step flow still fits on a screen, and a steady
 * angular curl keeps long chains winding around the nucleus organically.
 */
export function layoutRadial(graph: Graph): Layout {
  const rank = rankNodes(graph);
  const rings = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const r = rank.get(n.id) ?? 0;
    rings.set(r, [...(rings.get(r) ?? []), n.id]);
  }
  const maxRank = Math.max(0, ...rank.values());
  const radiusOf = (r: number) => (r === 0 ? 0 : 120 * Math.pow(r, 0.72));
  const size = Math.max(560, 2 * radiusOf(maxRank) + 340);
  const c = size / 2;
  const CURL = 0.85; // radians of drift per rank — the spiral

  const parents = new Map<string, string[]>();
  for (const n of graph.nodes) parents.set(n.id, []);
  for (const e of graph.edges) parents.get(e.to)?.push(e.from);

  const angles = new Map<string, number>();
  const placed = new Map<string, LaidOutNode>();

  for (let r = 0; r <= maxRank; r++) {
    const ids = rings.get(r) ?? [];
    if (!ids.length) continue;
    const desired = ids.map((id) => {
      const ps = (parents.get(id) ?? []).filter((p) => angles.has(p));
      const base = ps.length
        ? ps.reduce((s, p) => s + angles.get(p)!, 0) / ps.length
        : -Math.PI / 2;
      return { id, angle: base + (r === 0 ? 0 : CURL) + (wobble(id, "a") / 200) };
    }).sort((a, b) => a.angle - b.angle);

    // Same-shell neighbors must not overlap: nudge apart to a minimum gap.
    const minGap = r === 0 ? (2 * Math.PI) / Math.max(1, ids.length) : 170 / Math.max(radiusOf(r), 170);
    for (let i = 1; i < desired.length; i++) {
      if (desired[i].angle - desired[i - 1].angle < minGap) {
        desired[i].angle = desired[i - 1].angle + minGap;
      }
    }

    desired.forEach((d, i) => {
      const angle = r === 0 && ids.length > 1 ? -Math.PI / 2 + (i * 2 * Math.PI) / ids.length : d.angle;
      angles.set(d.id, angle);
      const radius = radiusOf(r);
      const node = graph.nodes.find((n) => n.id === d.id)!;
      placed.set(d.id, {
        id: d.id, node: node.node, rank: r,
        x: c + radius * Math.cos(angle) - NODE_W / 2,
        y: c + radius * Math.sin(angle) - ORB_CY,
        width: NODE_W, height: NODE_H,
      });
    });
  }

  // The spiral wanders — crop the canvas to where it actually went, so the
  // cell fills the frame instead of floating in empty space.
  const all = [...placed.values()];
  const PAD2 = 46;
  const minX = Math.min(...all.map((n) => n.x));
  const minY = Math.min(...all.map((n) => n.y));
  const maxX = Math.max(...all.map((n) => n.x + n.width));
  const maxY = Math.max(...all.map((n) => n.y + n.height));
  for (const n of all) { n.x += PAD2 - minX; n.y += PAD2 - minY; }

  const center = (n: LaidOutNode) => ({ x: n.x + n.width / 2, y: n.y + ORB_CY });
  const edges: LaidOutEdge[] = graph.edges
    .filter((e) => placed.has(e.from) && placed.has(e.to))
    .map((e) => {
      const a = center(placed.get(e.from)!);
      const b = center(placed.get(e.to)!);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / len, uy = dy / len;
      const sx = a.x + ux * ORB_R, sy = a.y + uy * ORB_R;
      const ex = b.x - ux * ORB_R, ey = b.y - uy * ORB_R;
      const w = wobble(e.from, e.to) * Math.min(2.2, len / 90);
      const mx = (sx + ex) / 2 - uy * w;
      const my = (sy + ey) / 2 + ux * w;
      return { from: e.from, to: e.to, path: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}` };
    });

  return { nodes: all, edges, width: maxX - minX + PAD2 * 2, height: maxY - minY + PAD2 * 2 };
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
