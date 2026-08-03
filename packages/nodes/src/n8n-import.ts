import { readFileSync } from "node:fs";
import type { Graph, NodeDef } from "@squidclaw/kernel";
import { isSupportedN8nType } from "./n8n-step.js";

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

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";

/**
 * Translates an n8n workflow into a SquidFlow.
 *
 * Every step becomes an n8n.step dispatcher call carrying its original type,
 * name and parameters — so it RUNS, expressions and branching included.
 * Shape and wiring survive exactly; branch outputs (IF true/false, Switch
 * cases) map onto branch-tagged edges. Types the dialect doesn't speak yet
 * are reported, and fail loudly at run time rather than silently.
 */
export function importN8nWorkflow(wf: N8nWorkflow): ImportResult {
  const unsupported: ImportResult["unsupported"] = [];
  const ids = new Map<string, string>();
  const nodes: Graph["nodes"] = [];
  const flowSlug = slug(wf.name ?? "imported");

  const active = (wf.nodes ?? []).filter(
    (n) => !n.disabled && n.type !== "n8n-nodes-base.stickyNote",
  );
  active.forEach((n, i) => {
    const id = `${slug(n.name)}-${i + 1}`;
    ids.set(n.name, id);
    if (!isSupportedN8nType(n.type)) unsupported.push({ node: n.name, type: n.type });
    nodes.push({
      id,
      node: "n8n.step",
      params: {
        type: n.type,
        n8nName: n.name,
        parameters: n.parameters ?? {},
        __flow: flowSlug,
      },
    });
  });

  const edges: Graph["edges"] = [];
  for (const [from, conn] of Object.entries(wf.connections ?? {})) {
    const fromId = ids.get(from);
    if (!fromId) continue;
    (conn.main ?? []).forEach((branchTargets, branch) => {
      for (const target of branchTargets ?? []) {
        const toId = ids.get(target.node);
        if (toId) edges.push({ from: fromId, to: toId, ...(branch ? { branch } : {}) });
      }
    });
  }

  return { graph: { nodes, edges }, name: wf.name ?? "imported workflow", unsupported };
}

export const squidflowImportNode: NodeDef = {
  name: "squidflow.import",
  description:
    "Import an n8n-exported workflow JSON file as a SquidFlow — a runnable graph. Params: path (to the .json file, required). Returns the SquidFlow graph, plus any step types that have no native support yet.",
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

/** Kept for old imported flows on disk that still reference it. */
export const unsupportedNode: NodeDef = {
  name: "unsupported.node",
  description: "Placeholder for an imported n8n node type this agent cannot run yet. Always fails, on purpose.",
  inputSchema: { type: "object", additionalProperties: true },
  run: async (params) => {
    throw new Error(`Unsupported imported node type "${params.n8nType}" (${params.n8nName}) — needs a native equivalent`);
  },
};
