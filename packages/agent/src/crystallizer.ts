import type { ExecutionRecord, Graph, Journal } from "@squidclaw/kernel";
import type { Flow } from "./flows.js";

/** Two runs are "the same task" when they took the same shape. */
export function graphSignature(graph: Graph): string {
  return graph.nodes.map((n) => n.node).join("|");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "habit";

/** Names a habit after the shape of the work: "web-search-web-read". */
export function nameFor(graph: Graph): string {
  return slug(graph.nodes.map((n) => n.node.replace(/\./g, "-")).join("-"));
}

interface Parameterized {
  graph: Graph;
  params: string[];
}

/**
 * Freezes what stayed the same, opens up what changed.
 *
 * Across N runs of the same shape, any param value that was identical every
 * time is baked in; anything that varied becomes a {{placeholder}} the habit
 * asks for. That difference is the whole trick — it's what turns one recorded
 * run into a reusable skill.
 */
export function parameterize(graphs: Graph[]): Parameterized {
  const base = graphs[0];
  const params: string[] = [];
  const used = new Set<string>();

  const nameParam = (key: string): string => {
    let name = slug(key).replace(/-/g, "_") || "value";
    let n = 2;
    while (used.has(name)) name = `${slug(key).replace(/-/g, "_")}_${n++}`;
    used.add(name);
    params.push(name);
    return name;
  };

  const merge = (path: string, values: unknown[]): unknown => {
    const [first] = values;

    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      const keys = new Set(values.flatMap((v) => Object.keys((v ?? {}) as object)));
      return Object.fromEntries(
        [...keys].map((k) => [
          k,
          merge(k, values.map((v) => (v as Record<string, unknown> | undefined)?.[k])),
        ]),
      );
    }

    const allSame = values.every((v) => JSON.stringify(v) === JSON.stringify(first));
    if (allSame) return first;
    return `{{${nameParam(path)}}}`;
  };

  const nodes = base.nodes.map((node, i) => ({
    ...node,
    params: merge(node.node, graphs.map((g) => g.nodes[i]?.params ?? {})) as Record<string, unknown>,
  }));

  return { graph: { nodes, edges: [...base.edges] }, params };
}

export interface Candidate {
  signature: string;
  executions: ExecutionRecord[];
}

/** Looks back through what it has lived, for work it has done more than once. */
export function findRepeatedWork(
  journal: Journal,
  tenantId: string,
  opts: { minRuns?: number; scan?: number } = {},
): Candidate[] {
  const minRuns = opts.minRuns ?? 2;
  const bySignature = new Map<string, ExecutionRecord[]>();

  for (const exec of journal.list({ tenantId, limit: opts.scan ?? 200 })) {
    if (exec.kind !== "improvised" || exec.status !== "ok") continue;
    if (!exec.graph.nodes.length) continue;
    // A habit made only of remembering isn't a skill worth freezing.
    if (exec.graph.nodes.every((n) => n.node.startsWith("memory."))) continue;
    const sig = graphSignature(exec.graph);
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), exec]);
  }

  return [...bySignature.entries()]
    .filter(([, execs]) => execs.length >= minRuns)
    .map(([signature, executions]) => ({ signature, executions }));
}

export function crystallize(candidate: Candidate, triggers: string[] = []): Flow {
  const graphs = candidate.executions.map((e) => e.graph);
  const { graph, params } = parameterize(graphs);
  const steps = graph.nodes.map((n) => n.node).join(" → ");

  return {
    name: nameFor(graph),
    description: `Runs ${steps}${params.length ? ` for a given ${params.join(", ")}` : ""}.`,
    signature: candidate.signature,
    triggers,
    params,
    graph,
    runs: candidate.executions.length,
    createdAt: new Date().toISOString(),
    status: "draft",
  };
}
