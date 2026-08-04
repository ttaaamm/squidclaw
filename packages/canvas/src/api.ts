import type { ExecutionRecord, Journal } from "@squidclaw/kernel";
import type { Flow, FlowStore } from "@squidclaw/agent";
import type { Reflex, ReflexStore } from "@squidclaw/reflexes";
import { layoutGraph, type Layout } from "./layout.js";

export interface MindSummary {
  via: string;
  tools: number;
}

export interface DashboardState {
  mind: MindSummary;
  habits: Array<Pick<Flow, "name" | "description" | "params" | "runs" | "status">>;
  drafts: Array<Pick<Flow, "name" | "description" | "params" | "runs" | "status">>;
  reflexes: Reflex[];
  memories: Array<{ name: string; content: string }>;
  counts: { executions: number; habits: number; reflexes: number };
}

export interface ExecutionSummary {
  id: string;
  kind: ExecutionRecord["kind"];
  status: ExecutionRecord["status"];
  steps: number;
  startedAt: string;
  finishedAt?: string;
  /** Node names in order — enough to recognise the run at a glance. */
  shape: string;
  durationMs?: number;
}

export interface ExecutionDetail extends ExecutionSummary {
  layout: Layout;
  nodes: Array<{
    id: string;
    node: string;
    params: Record<string, unknown>;
    status?: "ok" | "error" | "skipped";
    error?: string;
    input?: unknown[];
    output?: unknown[];
    durationMs?: number;
  }>;
}

const slim = (f: Flow) => ({
  name: f.name, description: f.description, params: f.params, runs: f.runs, status: f.status,
});

const ms = (from?: string, to?: string) =>
  from && to ? Math.max(0, new Date(to).getTime() - new Date(from).getTime()) : undefined;

export function summarize(execution: ExecutionRecord): ExecutionSummary {
  return {
    id: execution.id,
    kind: execution.kind,
    status: execution.status,
    steps: execution.steps.length,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    shape: execution.graph.nodes.map((n) => n.node).join(" → ") || "—",
    durationMs: ms(execution.startedAt, execution.finishedAt),
  };
}

/** Marries the recorded graph to the steps that ran through it. */
export function detail(execution: ExecutionRecord): ExecutionDetail {
  const byNodeId = new Map(execution.steps.map((s) => [s.nodeId, s]));
  return {
    ...summarize(execution),
    layout: layoutGraph(execution.graph),
    nodes: execution.graph.nodes.map((n) => {
      const step = byNodeId.get(n.id);
      return {
        id: n.id,
        node: n.node,
        params: n.params,
        status: step?.status,
        error: step?.error,
        input: step?.input.map((i) => i.json),
        output: step?.output.map((i) => i.json),
        durationMs: ms(step?.startedAt, step?.finishedAt),
      };
    }),
  };
}

export interface Sources {
  journal: Journal;
  flows: FlowStore;
  reflexes: ReflexStore;
  memories?: () => Array<{ name: string; content: string }>;
  mind: MindSummary;
  tenantId?: string;
}

export function dashboardState(src: Sources): DashboardState {
  const habits = src.flows.promoted();
  const drafts = src.flows.drafts();
  const reflexes = src.reflexes.all();
  return {
    mind: src.mind,
    habits: habits.map(slim),
    drafts: drafts.map(slim),
    reflexes,
    memories: src.memories?.() ?? [],
    counts: {
      executions: src.journal.list({ tenantId: src.tenantId, limit: 500 }).length,
      habits: habits.length,
      reflexes: reflexes.filter((r) => r.enabled).length,
    },
  };
}

export function executionList(src: Sources, limit = 50): ExecutionSummary[] {
  return src.journal.list({ tenantId: src.tenantId, limit }).map(summarize);
}

export function executionDetail(src: Sources, id: string): ExecutionDetail | undefined {
  const record = src.journal.get(id);
  return record ? detail(record) : undefined;
}
