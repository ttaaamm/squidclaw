/** One unit of data flowing between nodes. Always handled in arrays. */
export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, Buffer>;
}

export interface NodeContext {
  tenantId: string;
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
  edges: { from: string; to: string }[];
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
