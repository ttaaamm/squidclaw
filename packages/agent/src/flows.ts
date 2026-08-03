import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeGraph, type Graph, type Journal, type NodeDef } from "@squidclaw/kernel";

/** A habit: work the agent did twice, frozen into something it can repeat exactly. */
export interface Flow {
  name: string;
  description: string;
  /** Ordered node names — two runs with the same signature are "the same task". */
  signature: string;
  /** What the human said the times this was improvised. */
  triggers: string[];
  /** Values that varied between runs, and so must be supplied each time. */
  params: string[];
  graph: Graph;
  runs: number;
  createdAt: string;
  status: "draft" | "promoted";
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Fills {{name}} placeholders throughout a graph's params. */
export function renderGraph(graph: Graph, args: Record<string, unknown>): Graph {
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      // A lone placeholder keeps the argument's real type; inline ones interpolate.
      const whole = value.match(/^\{\{(\w+)\}\}$/);
      if (whole) return args[whole[1]] ?? "";
      return value.replace(PLACEHOLDER, (_m, key: string) => String(args[key] ?? ""));
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    }
    return value;
  };

  return {
    nodes: graph.nodes.map((n) => ({ ...n, params: fill(n.params) as Record<string, unknown> })),
    edges: [...graph.edges],
  };
}

const FLOW_FILE = /\.flow\.json$/;

/**
 * Where habits live. Drafts are habits the agent formed but a human hasn't
 * blessed yet — nothing runs automatically until someone says yes.
 */
export class FlowStore {
  private draftsDir: string;

  constructor(private dir: string) {
    this.draftsDir = join(dir, "_drafts");
    mkdirSync(this.draftsDir, { recursive: true });
  }

  private read(dir: string, status: Flow["status"]): Flow[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => FLOW_FILE.test(f))
      .map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Flow), status }));
  }

  drafts(): Flow[] {
    return this.read(this.draftsDir, "draft");
  }

  promoted(): Flow[] {
    return this.read(this.dir, "promoted");
  }

  all(): Flow[] {
    return [...this.promoted(), ...this.drafts()];
  }

  find(name: string): Flow | undefined {
    return this.all().find((f) => f.name === name);
  }

  hasSignature(signature: string): boolean {
    return this.all().some((f) => f.signature === signature);
  }

  saveDraft(flow: Flow): string {
    const path = join(this.draftsDir, `${flow.name}.flow.json`);
    writeFileSync(path, `${JSON.stringify({ ...flow, status: "draft" }, null, 2)}\n`, "utf8");
    return path;
  }

  /** The human's yes. Only promoted habits are ever offered as tools. */
  promote(name: string): boolean {
    const from = join(this.draftsDir, `${name}.flow.json`);
    if (!existsSync(from)) return false;
    const flow = JSON.parse(readFileSync(from, "utf8")) as Flow;
    writeFileSync(
      join(this.dir, `${name}.flow.json`),
      `${JSON.stringify({ ...flow, status: "promoted" }, null, 2)}\n`,
      "utf8",
    );
    renameSync(from, `${from}.promoted`);
    return true;
  }
}

/**
 * A habit, dressed as a tool.
 *
 * This is why the spec insisted flows carry a tool-call manifest: once a habit
 * is a node, the agent can reach for it exactly like any other capability —
 * and running it is deterministic, no improvisation inside.
 */
export function flowNode(flow: Flow, journal: Journal): NodeDef {
  return {
    name: `flow.${flow.name}`,
    description: `[habit, learned from ${flow.runs} runs] ${flow.description}${
      flow.params.length ? ` Params: ${flow.params.join(", ")}.` : ""
    }`,
    inputSchema: {
      type: "object",
      required: flow.params,
      properties: Object.fromEntries(flow.params.map((p) => [p, { type: "string" }])),
    },
    run: async (params, _items, ctx) => {
      const rec = await executeGraph(renderGraph(flow.graph, params), {
        tenantId: ctx.tenantId,
        kind: "flow",
        journal,
      });
      const last = rec.steps.at(-1);
      if (rec.status === "error") {
        throw new Error(`habit "${flow.name}" failed at ${last?.node}: ${last?.error}`);
      }
      return last?.output ?? [{ json: { ok: true, habit: flow.name } }];
    },
  };
}
