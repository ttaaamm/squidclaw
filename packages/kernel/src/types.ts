/** One unit of data flowing between nodes. Always handled in arrays. */
export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, Buffer>;
}

export interface NodeContext {
  tenantId: string;
  /** During a graph run: previous nodes' outputs by node id — lets compat code reach back like n8n's $('Node'). */
  outputs?: Map<string, Item[][]>;
  /** Maps a node's display name to its id, for the same reach-back. */
  nodeIds?: Map<string, string>;
}

const BRANCHES = Symbol.for("squidclaw.branches");

/**
 * Branching nodes (IF/Switch) return their items with per-branch streams
 * attached — invisibly, so every ordinary node stays a plain Item[].
 */
export function withBranches(outputs: Item[][]): Item[] {
  const flat = outputs.flat();
  (flat as unknown as Record<symbol, Item[][]>)[BRANCHES] = outputs;
  return flat;
}

export function branchesOf(items: Item[]): Item[][] | undefined {
  return (items as unknown as Record<symbol, Item[][] | undefined>)[BRANCHES];
}

/** A capability the agent can call. Tool-call shaped so flows/nodes are agent-callable. */
export interface NodeDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(
    params: Record<string, unknown>,
    items: Item[],
    ctx: NodeContext,
  ): Promise<Item[]>;
}

export interface GraphNode {
  id: string;
  node: string;
  params: Record<string, unknown>;
}

export interface Graph {
  nodes: GraphNode[];
  /** `branch` picks which of the upstream node's outputs flows here (default 0). */
  edges: { from: string; to: string; branch?: number }[];
}

export interface StepRecord {
  nodeId: string;
  node: string;
  params: Record<string, unknown>;
  input: Item[];
  output: Item[];
  status: "ok" | "error";
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Improvised = the agent thought it up live. Flow = a crystallized habit. Same shape. */
export type ExecutionKind = "improvised" | "flow";
export type ExecutionStatus = "running" | "ok" | "error";

export interface ExecutionRecord {
  id: string;
  tenantId: string;
  kind: ExecutionKind;
  status: ExecutionStatus;
  graph: Graph;
  steps: StepRecord[];
  startedAt: string;
  finishedAt?: string;
}
