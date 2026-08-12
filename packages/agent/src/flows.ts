import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeGraph, type Graph, type Journal, type NodeDef } from "@squidclaw/kernel";

/**
 * A parameter contract. The plain-string form is a bare required param
 * (what the crystallizer writes). The object form is a promise the platform
 * enforces: when the value is missing — or matches `reject`, a placeholder —
 * the PLATFORM asks the human `ask` and waits. The mind never has to
 * remember to ask, and can never invent its way past the gate.
 */
export interface ParamSpec {
  name: string;
  /** The question the platform asks the human when this value is missing. */
  ask?: string;
  /** Allowed values; answers are matched case-insensitively. */
  options?: string[];
  /** Used when the value is absent — a param with a default is never asked. */
  default?: string;
  /** Values matching this regex (case-insensitive) are placeholders, treated as missing. */
  reject?: string;
}
export type FlowParam = string | ParamSpec;

/** A habit: work the agent did twice, frozen into something it can repeat exactly. */
export interface Flow {
  name: string;
  description: string;
  /** Ordered node names — two runs with the same signature are "the same task". */
  signature: string;
  /** What the human said the times this was improvised. */
  triggers: string[];
  /** Values that varied between runs, and so must be supplied each time. */
  params: FlowParam[];
  graph: Graph;
  runs: number;
  createdAt: string;
  status: "draft" | "promoted";
}

/** Every param, in contract form — bare strings become required specs. */
export function paramSpecs(flow: Flow): ParamSpec[] {
  return (flow.params ?? []).map((p) => (typeof p === "string" ? { name: p } : p));
}

const isPlaceholder = (spec: ParamSpec, value: string): boolean =>
  !!spec.reject && new RegExp(spec.reject, "i").test(value);

const matchOption = (spec: ParamSpec, value: string): string | undefined =>
  spec.options?.find((o) => o.toLowerCase() === value.toLowerCase());

/**
 * Which params the human still owes. Missing, empty, placeholder-shaped, or
 * outside the declared options — unless a default covers the absence.
 */
export function missingParams(flow: Flow, args: Record<string, unknown>): ParamSpec[] {
  return paramSpecs(flow).filter((spec) => {
    const value = String(args[spec.name] ?? "").trim();
    if (!value) return spec.default === undefined;
    if (isPlaceholder(spec, value)) return true;
    if (spec.options && !matchOption(spec, value)) return spec.default === undefined;
    return false;
  });
}

/** The final argument set: given values (normalized to options) plus defaults. */
export function resolveArgs(flow: Flow, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const spec of paramSpecs(flow)) {
    const value = String(out[spec.name] ?? "").trim();
    const bad = !value || isPlaceholder(spec, value) || (spec.options && !matchOption(spec, value));
    if (bad) {
      if (spec.default !== undefined) out[spec.name] = spec.default;
    } else if (spec.options) {
      out[spec.name] = matchOption(spec, value);
    }
  }
  return out;
}

/** What a flow hands back instead of running when the human still owes details. */
export interface ElicitRequest {
  flow: string;
  given: Record<string, unknown>;
  missing: Array<{ name: string; ask: string; options?: string[] }>;
}

export function elicitFrom(flow: Flow, args: Record<string, unknown>): ElicitRequest | undefined {
  const missing = missingParams(flow, args);
  if (!missing.length) return undefined;
  const given: Record<string, unknown> = {};
  for (const spec of paramSpecs(flow)) {
    if (missing.some((m) => m.name === spec.name)) continue;
    if (args[spec.name] !== undefined) given[spec.name] = args[spec.name];
  }
  return {
    flow: flow.name,
    given,
    missing: missing.map((m) => ({
      name: m.name,
      ask: m.ask ?? `What should I use for "${m.name}"?`,
      ...(m.options ? { options: m.options } : {}),
    })),
  };
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
    const flows: Flow[] = [];
    for (const f of readdirSync(dir).filter((f) => FLOW_FILE.test(f))) {
      // One corrupt file must never take the whole platform down — a bad
      // hand-edit here once crash-looped the service for every tenant.
      // Skip it loudly; the rest of the body keeps working.
      try {
        flows.push({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Flow), status });
      } catch (err) {
        console.error(`flows: skipping unreadable ${join(dir, f)}: ${String(err)}`);
      }
    }
    return flows;
  }

  /**
   * A flow's instruction sheet — its own SKILL.md, living beside the flow
   * file as <name>.md. First line may declare relevance keywords
   * ("when: poster, artwork"); the rest is guidance the mind loads only
   * when a message touches that territory. Depth without paying its token
   * cost on every turn.
   */
  sheetFor(name: string): { when: string[]; body: string } | undefined {
    const path = join(this.dir, `${name}.md`);
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    const front = raw.match(/^when:\s*(.+)\r?\n/);
    const when = front
      ? front[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];
    const body = (front ? raw.slice(front[0].length) : raw).trim();
    return body ? { when, body } : undefined;
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
    return this.save(flow, "draft");
  }

  /**
   * Write a flow at a chosen status.
   *
   * Editing has to be able to reach a promoted habit — the canvas lets a human
   * fix a live flow — but promotion itself stays a separate, deliberate act
   * (`promote`), so saving an edit never silently arms a draft.
   */
  save(flow: Flow, status: "draft" | "promoted" = "draft"): string {
    const dir = status === "promoted" ? this.dir : this.draftsDir;
    const path = join(dir, `${flow.name}.flow.json`);
    writeFileSync(path, `${JSON.stringify({ ...flow, status }, null, 2)}\n`, "utf8");
    return path;
  }

  /**
   * Forget a habit entirely — both the draft and the promoted copy, plus the
   * `.promoted` tombstone `promote()` leaves behind. Returns whether anything
   * was actually there, so a caller can answer 404 honestly.
   */
  remove(name: string): boolean {
    let removed = false;
    for (const path of [
      join(this.dir, `${name}.flow.json`),
      join(this.draftsDir, `${name}.flow.json`),
      join(this.draftsDir, `${name}.flow.json.promoted`),
    ]) {
      if (!existsSync(path)) continue;
      unlinkSync(path);
      removed = true;
    }
    return removed;
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
  const specs = paramSpecs(flow);
  return {
    name: `flow.${flow.name}`,
    description: `[habit, learned from ${flow.runs} runs] ${flow.description}${
      specs.length
        ? ` Params: ${specs.map((p) => p.name).join(", ")}. Call with whatever the human actually said — if required details are missing, the platform will ask the human itself; never invent values.`
        : ""
    }`,
    inputSchema: {
      type: "object",
      // Nothing is schema-required: an incomplete call triggers the platform's
      // own interview instead of tempting the model to fill blanks with guesses.
      required: [],
      properties: Object.fromEntries(specs.map((p) => [p.name, { type: "string" }])),
    },
    run: async (params, _items, ctx) => {
      // The contract gate. Missing or placeholder-shaped values do not run
      // the flow and do not throw — they hand back an elicitation request
      // the platform turns into real questions to the real human.
      const elicit = elicitFrom(flow, params);
      if (elicit) return [{ json: { __elicit: elicit } as unknown as Record<string, unknown> }];

      const rec = await executeGraph(renderGraph(flow.graph, resolveArgs(flow, params)), {
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
