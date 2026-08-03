import { readFileSync } from "node:fs";
import type { Graph, NodeDef } from "@squidclaw/kernel";

/** The shape n8n exports. Only the parts we need. */
export interface N8nWorkflow {
  name?: string;
  nodes: Array<{
    name: string;
    type: string;
    parameters?: Record<string, unknown>;
    disabled?: boolean;
  }>;
  connections?: Record<string, { main?: Array<Array<{ node: string; index?: number }>> }>;
}

export interface ImportResult {
  graph: Graph;
  name: string;
  unsupported: Array<{ node: string; type: string }>;
}

/** n8n type -> our node name. Everything else lands as a placeholder we can see. */
const TYPE_MAP: Record<string, string> = {
  "n8n-nodes-base.httpRequest": "http.request",
  "n8n-nodes-base.noOp": "echo",
  "n8n-nodes-base.set": "echo",
  "n8n-nodes-base.manualTrigger": "echo",
  "n8n-nodes-base.executeWorkflowTrigger": "echo",
};

function mapParams(type: string, p: Record<string, unknown> = {}): Record<string, unknown> {
  if (type === "n8n-nodes-base.httpRequest") {
    return {
      url: p.url ?? p.uri ?? "",
      method: (p.method as string) ?? "GET",
      ...(p.jsonBody ? { body: p.jsonBody } : {}),
    };
  }
  return { ...p };
}

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";

/**
 * Translates an n8n workflow into our graph.
 *
 * Shape (nodes, wiring, order) always survives. Node types map where we have an
 * equivalent; anything else becomes an explicit `unsupported.node` step so a
 * broken import is visible in the journal rather than silently wrong.
 */
export function importN8nWorkflow(wf: N8nWorkflow): ImportResult {
  const unsupported: ImportResult["unsupported"] = [];
  const ids = new Map<string, string>();
  const nodes: Graph["nodes"] = [];

  const active = (wf.nodes ?? []).filter((n) => !n.disabled);
  active.forEach((n, i) => {
    const id = `${slug(n.name)}-${i + 1}`;
    ids.set(n.name, id);
    const mapped = TYPE_MAP[n.type];
    if (!mapped) unsupported.push({ node: n.name, type: n.type });
    nodes.push({
      id,
      node: mapped ?? "unsupported.node",
      params: mapped
        ? mapParams(n.type, n.parameters)
        : { n8nType: n.type, n8nName: n.name, parameters: n.parameters ?? {} },
    });
  });

  const edges: Graph["edges"] = [];
  for (const [from, conn] of Object.entries(wf.connections ?? {})) {
    const fromId = ids.get(from);
    if (!fromId) continue;
    for (const branch of conn.main ?? []) {
      for (const target of branch ?? []) {
        const toId = ids.get(target.node);
        if (toId) edges.push({ from: fromId, to: toId });
      }
    }
  }

  return { graph: { nodes, edges }, name: wf.name ?? "imported workflow", unsupported };
}

/** Stands in for an n8n node we can't run yet — loud, not silent. */
export const unsupportedNode: NodeDef = {
  name: "unsupported.node",
  description: "Placeholder for an imported n8n node type this agent cannot run yet. Always fails, on purpose.",
  inputSchema: { type: "object", additionalProperties: true },
  run: async (params) => {
    throw new Error(`Unsupported imported node type "${params.n8nType}" (${params.n8nName}) — needs a native equivalent`);
  },
};

export const n8nImportNode: NodeDef = {
  name: "squidflow.import",
  description:
    "Import an n8n-exported workflow JSON file as a SquidFlow — a runnable graph. Params: path (to the .json file, required). Returns the SquidFlow graph, plus any node types that have no native equivalent yet.",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  run: async (params) => {
    const wf = JSON.parse(readFileSync(String(params.path), "utf8")) as N8nWorkflow;
    const result = importN8nWorkflow(wf);
    return [
      {
        json: {
          name: result.name,
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
          unsupported: result.unsupported,
          graph: result.graph as unknown as Record<string, unknown>,
        },
      },
    ];
  },
};
