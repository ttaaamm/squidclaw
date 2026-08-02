# SquidClaw Phases 0–1 (Birth Certificate + Heartbeat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A living walking skeleton: message the agent on Telegram → it improvises a task using tool-nodes routed through multi-brain LLM calls → the entire run is recorded as a graph in the journal and queryable via CLI.

**Architecture:** TypeScript monorepo (npm workspaces). The **kernel** is the spine: node registry, items model, graph walker, SQLite journal — no LLM, no chat. **brains** routes tier-based LLM calls (Anthropic, fallback lists). **agent** is a kernel client that improvises: each LLM tool-call executes a registered node and is recorded as a step in one `improvised` execution. **surfaces** adapts Telegram (grammY long-polling) to the agent. **server** wires everything (dev runner + journal CLI). Everything-is-an-execution: improvised runs and future flows share one format.

**Tech Stack:** Node ≥22, TypeScript 5, npm workspaces, vitest, tsx (no build/dist — run TS directly), better-sqlite3, @anthropic-ai/sdk, grammy, yaml, dotenv.

## Global Constraints (from spec §3, verbatim rules)

- Every table carries `tenant_id`.
- Steps/nodes declare a **brain tier** (`cheap|writer|vision|coder|auto` — v1 implements `cheap` and `strong`), never a hardcoded model name in code. Models live only in `workspace/BRAINS.yaml`.
- Data between nodes is always an **array of items** `{json, binary?}`.
- Node/flow manifests are tool-call shaped: `{name, description, inputSchema}`.
- Kernel never assumes "our server": SQLite path, keys, tokens all come from config/env.
- Clean-room: zero code copied from OpenClaw, n8n, or squidclaw-legacy.
- Repo: `git@github.com:ttaaamm/squidclaw.git`, branch `main`, local checkout `C:\Users\Tamer\OneDrive\Desktop\N8N`.
- Secrets (`.env`, `workspace/journal/`) are gitignored; `.env.example` documents required vars.
- Prod deploy target (final task only, **requires Tamer's explicit go**): Preplix VPS `/opt/agenticflow`, localhost-only.

## Prerequisites (Tamer actions, before Task 8 can be verified live)

- `ANTHROPIC_API_KEY` — from console.anthropic.com.
- `TELEGRAM_BOT_TOKEN` — create a new bot via @BotFather (suggested handle: anything; this is the dev bot, not the product bot).

## File Structure

```
N8N/                                  (repo root, already has docs/)
├── package.json                      # workspaces root, scripts
├── tsconfig.base.json  tsconfig.json # strict TS, no emit
├── vitest.config.ts  .gitignore  .env.example
├── .github/workflows/ci.yml
├── workspace/                        # the dev agent's body (spec §2)
│   ├── SOUL.md  BRAINS.yaml
│   └── journal/                      # executions.db lives here (gitignored)
└── packages/
    ├── kernel/src/{types,registry,journal,walker,index}.ts + test/
    ├── brains/src/{config,router,index}.ts + test/
    ├── nodes/src/{echo,http-request,index}.ts + test/
    ├── agent/src/{improviser,index}.ts + test/
    ├── surfaces/src/{surface,telegram,index}.ts + test/
    └── server/src/{dev,cli}.ts
```

---

### Task 1: Monorepo scaffold + CI

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`, `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `packages/kernel/src/index.ts`, `packages/kernel/test/smoke.test.ts` (equivalent `package.json`+`tsconfig.json` for brains, nodes, agent, surfaces, server)

**Interfaces:**
- Produces: workspace packages importable as `@squidclaw/kernel`, `@squidclaw/brains`, `@squidclaw/nodes`, `@squidclaw/agent`, `@squidclaw/surfaces`; scripts `npm test`, `npm run typecheck`.

- [ ] **Step 1: Root package.json**

```json
{
  "name": "squidclaw",
  "private": true,
  "engines": { "node": ">=22" },
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "dev": "tsx packages/server/src/dev.ts",
    "journal": "tsx packages/server/src/cli.ts"
  }
}
```

- [ ] **Step 2: tsconfig.base.json + root tsconfig.json**

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "esModuleInterop": true, "resolveJsonModule": true, "types": ["node"]
  }
}
// tsconfig.json
{ "extends": "./tsconfig.base.json", "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts"] }
```

- [ ] **Step 3: Per-package package.json** — same shape for all six (change the name):

```json
{
  "name": "@squidclaw/kernel",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

Per-package `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`
`packages/kernel/src/index.ts` (placeholder for now): `export const KERNEL = "kernel";`
Other packages: empty `src/index.ts` with `export {};`

- [ ] **Step 4: vitest.config.ts, .gitignore, .env.example**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts"] } });
```

```
# .gitignore
node_modules/
.env
workspace/journal/
*.db
```

```
# .env.example
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC...
```

- [ ] **Step 5: Install deps**

Run: `npm i -D typescript tsx vitest @types/node && npm i better-sqlite3 @anthropic-ai/sdk grammy yaml dotenv && npm i -D @types/better-sqlite3`
Expected: lockfile created, no errors.

- [ ] **Step 6: Smoke test** — `packages/kernel/test/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { KERNEL } from "@squidclaw/kernel";
describe("workspace wiring", () => { it("resolves cross-package imports", () => { expect(KERNEL).toBe("kernel"); }); });
```

- [ ] **Step 7: Run `npm test` and `npm run typecheck`** — Expected: 1 test passes, typecheck clean.

- [ ] **Step 8: CI** — `.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold (workspaces, vitest, CI)"
```

---

### Task 2: Kernel — types + node registry

**Files:**
- Create: `packages/kernel/src/types.ts`, `packages/kernel/src/registry.ts`; Modify: `packages/kernel/src/index.ts`; Test: `packages/kernel/test/registry.test.ts`

**Interfaces:**
- Produces (exact, used by every later task):

```ts
export interface Item { json: Record<string, unknown>; binary?: Record<string, Buffer>; }
export interface NodeContext { tenantId: string; }
export interface NodeDef {
  name: string; description: string;
  inputSchema: Record<string, unknown>;
  run(params: Record<string, unknown>, items: Item[], ctx: NodeContext): Promise<Item[]>;
}
export interface GraphNode { id: string; node: string; params: Record<string, unknown>; }
export interface Graph { nodes: GraphNode[]; edges: { from: string; to: string }[]; }
export interface StepRecord {
  nodeId: string; node: string; params: Record<string, unknown>;
  input: Item[]; output: Item[]; status: "ok" | "error"; error?: string;
  startedAt: string; finishedAt: string;
}
export type ExecutionKind = "improvised" | "flow";
export type ExecutionStatus = "running" | "ok" | "error";
export interface ExecutionRecord {
  id: string; tenantId: string; kind: ExecutionKind; status: ExecutionStatus;
  graph: Graph; steps: StepRecord[]; startedAt: string; finishedAt?: string;
}
// registry.ts
export function registerNode(def: NodeDef): void;      // throws on duplicate name
export function getNode(name: string): NodeDef | undefined;
export function listNodes(): NodeDef[];
export function clearNodes(): void;                    // tests only
```

- [ ] **Step 1: Failing test** — `packages/kernel/test/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerNode, getNode, listNodes, clearNodes, type NodeDef } from "@squidclaw/kernel";
const echo: NodeDef = {
  name: "echo", description: "returns its params as one item",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  run: async (params) => [{ json: { ...params } }],
};
describe("node registry", () => {
  beforeEach(clearNodes);
  it("registers and retrieves a node", () => {
    registerNode(echo);
    expect(getNode("echo")?.description).toContain("params");
    expect(listNodes().map(n => n.name)).toEqual(["echo"]);
  });
  it("rejects duplicate names", () => {
    registerNode(echo);
    expect(() => registerNode(echo)).toThrow(/already registered/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/kernel/test/registry.test.ts` — Expected: FAIL (no export).

- [ ] **Step 3: Implement** — `types.ts` exactly as the Interfaces block above; `registry.ts`:

```ts
import type { NodeDef } from "./types.js";
const nodes = new Map<string, NodeDef>();
export function registerNode(def: NodeDef): void {
  if (nodes.has(def.name)) throw new Error(`Node "${def.name}" already registered`);
  nodes.set(def.name, def);
}
export const getNode = (name: string) => nodes.get(name);
export const listNodes = () => [...nodes.values()];
export const clearNodes = () => nodes.clear();
```

`index.ts`: `export * from "./types.js"; export * from "./registry.js";` (drop the `KERNEL` placeholder; update smoke test to import `listNodes` instead).

- [ ] **Step 4: Run tests** — Expected: PASS. **Step 5: Commit** `feat(kernel): items model, core types, node registry`

---

### Task 3: Kernel — journal (SQLite)

**Files:**
- Create: `packages/kernel/src/journal.ts`; Modify: `packages/kernel/src/index.ts`; Test: `packages/kernel/test/journal.test.ts`

**Interfaces:**
- Produces:

```ts
export class Journal {
  constructor(dbPath: string);                          // ":memory:" ok for tests; creates tables
  begin(meta: { tenantId: string; kind: ExecutionKind; graph: Graph }): string;  // returns execution id
  recordStep(executionId: string, step: StepRecord): void;
  setGraph(executionId: string, graph: Graph): void;    // improviser builds graph incrementally
  finish(executionId: string, status: "ok" | "error"): void;
  get(executionId: string): ExecutionRecord | undefined;
  list(opts?: { tenantId?: string; limit?: number }): ExecutionRecord[];  // newest first
  close(): void;
}
```

- [ ] **Step 1: Failing test** — `packages/kernel/test/journal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Journal, type Graph, type StepRecord } from "@squidclaw/kernel";
const g: Graph = { nodes: [{ id: "n1", node: "echo", params: { value: "hi" } }], edges: [] };
const step: StepRecord = {
  nodeId: "n1", node: "echo", params: { value: "hi" }, input: [], output: [{ json: { value: "hi" } }],
  status: "ok", startedAt: "2026-08-03T00:00:00Z", finishedAt: "2026-08-03T00:00:01Z",
};
describe("journal", () => {
  it("records a full execution lifecycle", () => {
    const j = new Journal(":memory:");
    const id = j.begin({ tenantId: "t1", kind: "improvised", graph: g });
    j.recordStep(id, step);
    j.finish(id, "ok");
    const rec = j.get(id)!;
    expect(rec.status).toBe("ok");
    expect(rec.tenantId).toBe("t1");
    expect(rec.steps).toHaveLength(1);
    expect(rec.steps[0].output[0].json.value).toBe("hi");
    expect(rec.finishedAt).toBeDefined();
  });
  it("lists by tenant, newest first", () => {
    const j = new Journal(":memory:");
    const a = j.begin({ tenantId: "t1", kind: "flow", graph: g });
    j.begin({ tenantId: "t2", kind: "flow", graph: g });
    expect(j.list({ tenantId: "t1" }).map(e => e.id)).toEqual([a]);
    expect(j.list()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** `journal.ts`:

```ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionKind, ExecutionRecord, Graph, StepRecord } from "./types.js";

export class Journal {
  private db: Database.Database;
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, graph TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS steps (
        execution_id TEXT NOT NULL, tenant_id TEXT NOT NULL, seq INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY (execution_id, seq));`);
  }
  begin(meta: { tenantId: string; kind: ExecutionKind; graph: Graph }): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO executions VALUES (?,?,?,?,?,?,NULL)`)
      .run(id, meta.tenantId, meta.kind, "running", JSON.stringify(meta.graph), new Date().toISOString());
    return id;
  }
  recordStep(executionId: string, step: StepRecord): void {
    const row = this.db.prepare(`SELECT tenant_id, COALESCE(MAX(seq),0) AS mx FROM executions e
      LEFT JOIN steps s ON s.execution_id = e.id WHERE e.id = ?`).get(executionId) as { tenant_id: string; mx: number };
    this.db.prepare(`INSERT INTO steps VALUES (?,?,?,?)`)
      .run(executionId, row.tenant_id, row.mx + 1, JSON.stringify(step));
  }
  setGraph(executionId: string, graph: Graph): void {
    this.db.prepare(`UPDATE executions SET graph = ? WHERE id = ?`).run(JSON.stringify(graph), executionId);
  }
  finish(executionId: string, status: "ok" | "error"): void {
    this.db.prepare(`UPDATE executions SET status = ?, finished_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), executionId);
  }
  get(executionId: string): ExecutionRecord | undefined {
    const e = this.db.prepare(`SELECT * FROM executions WHERE id = ?`).get(executionId) as any;
    if (!e) return undefined;
    const steps = (this.db.prepare(`SELECT data FROM steps WHERE execution_id = ? ORDER BY seq`).all(executionId) as any[])
      .map(r => JSON.parse(r.data) as StepRecord);
    return { id: e.id, tenantId: e.tenant_id, kind: e.kind, status: e.status,
      graph: JSON.parse(e.graph), steps, startedAt: e.started_at, finishedAt: e.finished_at ?? undefined };
  }
  list(opts: { tenantId?: string; limit?: number } = {}): ExecutionRecord[] {
    const rows = (opts.tenantId
      ? this.db.prepare(`SELECT id FROM executions WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?`).all(opts.tenantId, opts.limit ?? 50)
      : this.db.prepare(`SELECT id FROM executions ORDER BY started_at DESC LIMIT ?`).all(opts.limit ?? 50)) as any[];
    return rows.map(r => this.get(r.id)!);
  }
  close(): void { this.db.close(); }
}
```

Add `export * from "./journal.js";` to `index.ts`.

- [ ] **Step 4: Run tests** — Expected: PASS. **Step 5: Commit** `feat(kernel): sqlite journal — executions + steps, tenant-scoped`

---

### Task 4: Kernel — graph walker

**Files:**
- Create: `packages/kernel/src/walker.ts`; Modify: `packages/kernel/src/index.ts`; Test: `packages/kernel/test/walker.test.ts`

**Interfaces:**
- Consumes: `getNode` (Task 2), `Journal` (Task 3).
- Produces: `export async function executeGraph(graph: Graph, opts: { tenantId: string; kind?: ExecutionKind; journal: Journal }): Promise<ExecutionRecord>` — topological order, items flow along edges (multi-input = concatenated), every node recorded as a step, node error → step recorded with `status:"error"`, execution finished `"error"`, no throw.

- [ ] **Step 1: Failing test** — `packages/kernel/test/walker.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerNode, clearNodes, Journal, executeGraph, type Graph, type Item } from "@squidclaw/kernel";
describe("graph walker", () => {
  beforeEach(() => {
    clearNodes();
    registerNode({ name: "emit", description: "emits params.value", inputSchema: {},
      run: async (p) => [{ json: { value: p.value } }] });
    registerNode({ name: "upper", description: "uppercases value of each item", inputSchema: {},
      run: async (_p, items: Item[]) => items.map(i => ({ json: { value: String(i.json.value).toUpperCase() } })) });
    registerNode({ name: "boom", description: "always throws", inputSchema: {},
      run: async () => { throw new Error("boom"); } });
  });
  it("walks a chain, items flow, journal records steps", async () => {
    const g: Graph = { nodes: [
      { id: "a", node: "emit", params: { value: "hi" } },
      { id: "b", node: "upper", params: {} }], edges: [{ from: "a", to: "b" }] };
    const rec = await executeGraph(g, { tenantId: "t1", journal: new Journal(":memory:") });
    expect(rec.status).toBe("ok");
    expect(rec.steps).toHaveLength(2);
    expect(rec.steps[1].output[0].json.value).toBe("HI");
  });
  it("records failure and finishes as error without throwing", async () => {
    const g: Graph = { nodes: [{ id: "a", node: "boom", params: {} }], edges: [] };
    const rec = await executeGraph(g, { tenantId: "t1", journal: new Journal(":memory:") });
    expect(rec.status).toBe("error");
    expect(rec.steps[0].status).toBe("error");
    expect(rec.steps[0].error).toContain("boom");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** `walker.ts`:

```ts
import { getNode } from "./registry.js";
import type { ExecutionKind, ExecutionRecord, Graph, Item } from "./types.js";
import type { Journal } from "./journal.js";

function topoSort(graph: Graph): string[] {
  const indeg = new Map(graph.nodes.map(n => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = graph.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges.filter(e => e.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== graph.nodes.length) throw new Error("Graph has a cycle");
  return order;
}

export async function executeGraph(
  graph: Graph, opts: { tenantId: string; kind?: ExecutionKind; journal: Journal },
): Promise<ExecutionRecord> {
  const execId = opts.journal.begin({ tenantId: opts.tenantId, kind: opts.kind ?? "flow", graph });
  const outputs = new Map<string, Item[]>();
  let failed = false;
  for (const nodeId of topoSort(graph)) {
    const gn = graph.nodes.find(n => n.id === nodeId)!;
    const def = getNode(gn.node);
    const input = graph.edges.filter(e => e.to === nodeId).flatMap(e => outputs.get(e.from) ?? []);
    const startedAt = new Date().toISOString();
    try {
      if (!def) throw new Error(`Unknown node type: ${gn.node}`);
      const output = await def.run(gn.params, input, { tenantId: opts.tenantId });
      outputs.set(nodeId, output);
      opts.journal.recordStep(execId, { nodeId, node: gn.node, params: gn.params, input, output,
        status: "ok", startedAt, finishedAt: new Date().toISOString() });
    } catch (err) {
      opts.journal.recordStep(execId, { nodeId, node: gn.node, params: gn.params, input, output: [],
        status: "error", error: String(err), startedAt, finishedAt: new Date().toISOString() });
      failed = true;
      break;
    }
  }
  opts.journal.finish(execId, failed ? "error" : "ok");
  return opts.journal.get(execId)!;
}
```

Add `export * from "./walker.js";` to `index.ts`.

- [ ] **Step 4: Run all tests** (`npm test`) — Expected: PASS. **Step 5: Commit** `feat(kernel): graph walker — topo order, item flow, journaled steps`

---

### Task 5: Nodes — echo + http.request

**Files:**
- Create: `packages/nodes/src/echo.ts`, `packages/nodes/src/http-request.ts`; Modify: `packages/nodes/src/index.ts`; Test: `packages/nodes/test/nodes.test.ts`

**Interfaces:**
- Consumes: `NodeDef`, `registerNode` from `@squidclaw/kernel`.
- Produces: `export const echoNode: NodeDef` (name `"echo"`), `export const httpRequestNode: NodeDef` (name `"http.request"`, params `{url: string, method?: "GET"|"POST", body?: unknown}` → `[{json: {status: number, body: unknown}}]`), `export function registerBuiltinNodes(): void`.

- [ ] **Step 1: Failing test** — `packages/nodes/test/nodes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { clearNodes, getNode } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, method: req.method }));
});
await new Promise<void>(r => server.listen(0, r));
const port = (server.address() as { port: number }).port;
afterAll(() => server.close());

describe("builtin nodes", () => {
  beforeEach(() => { clearNodes(); registerBuiltinNodes(); });
  it("echo returns params as one item", async () => {
    const out = await getNode("echo")!.run({ value: 42 }, [], { tenantId: "t" });
    expect(out).toEqual([{ json: { value: 42 } }]);
  });
  it("http.request GETs and parses JSON", async () => {
    const out = await getNode("http.request")!.run({ url: `http://127.0.0.1:${port}/` }, [], { tenantId: "t" });
    expect(out[0].json.status).toBe(200);
    expect((out[0].json.body as { ok: boolean }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement**

```ts
// echo.ts
import type { NodeDef } from "@squidclaw/kernel";
export const echoNode: NodeDef = {
  name: "echo",
  description: "Returns its params back as a single item. Use to relay or shape data.",
  inputSchema: { type: "object", properties: { value: {} }, additionalProperties: true },
  run: async (params) => [{ json: { ...params } }],
};
// http-request.ts
import type { NodeDef } from "@squidclaw/kernel";
export const httpRequestNode: NodeDef = {
  name: "http.request",
  description: "Makes an HTTP request. Params: url (required), method (GET|POST, default GET), body (JSON for POST). Returns {status, body}.",
  inputSchema: { type: "object", required: ["url"],
    properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] }, body: {} } },
  run: async (params) => {
    const method = (params.method as string) ?? "GET";
    const res = await fetch(params.url as string, {
      method,
      headers: params.body ? { "content-type": "application/json" } : undefined,
      body: params.body ? JSON.stringify(params.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return [{ json: { status: res.status, body } }];
  },
};
// index.ts
import { registerNode } from "@squidclaw/kernel";
import { echoNode } from "./echo.js";
import { httpRequestNode } from "./http-request.js";
export { echoNode, httpRequestNode };
export function registerBuiltinNodes(): void { registerNode(echoNode); registerNode(httpRequestNode); }
```

- [ ] **Step 4: Run tests** — Expected: PASS. **Step 5: Commit** `feat(nodes): echo + http.request builtins`

---

### Task 6: Brains — config + tier router with fallback

**Files:**
- Create: `packages/brains/src/config.ts`, `packages/brains/src/router.ts`; Modify: `packages/brains/src/index.ts`; Test: `packages/brains/test/router.test.ts`; Create: `workspace/BRAINS.yaml`

**Interfaces:**
- Produces:

```ts
export type Tier = "cheap" | "strong";
export interface BrainsConfig { tiers: Record<Tier, string[]>; }   // model ids, fallback order
export function loadBrainsConfig(yamlPath: string): BrainsConfig;  // throws if a tier is missing/empty
export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown>; }
export interface ToolCall { id: string; name: string; input: Record<string, unknown>; }
export interface CompleteResult { text: string; toolCalls: ToolCall[]; assistantContent: unknown[]; }
export interface CompleteRequest {
  tier: Tier; system?: string; messages: unknown[]; tools?: ToolSpec[]; maxTokens?: number;
}
// messagesCreate signature matches anthropic.messages.create — injectable for tests
export class Brains {
  constructor(config: BrainsConfig, messagesCreate?: (req: Record<string, unknown>) => Promise<unknown>);
  complete(req: CompleteRequest): Promise<CompleteResult>;  // tries tier models in order, throws last error
}
```

- [ ] **Step 1: Failing test** — `packages/brains/test/router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Brains, loadBrainsConfig, type BrainsConfig } from "@squidclaw/brains";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cfg: BrainsConfig = { tiers: { cheap: ["model-a"], strong: ["model-b", "model-c"] } };
const textResponse = { content: [{ type: "text", text: "hello" }] };

describe("brains router", () => {
  it("loads BRAINS.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "brains-"));
    writeFileSync(join(dir, "BRAINS.yaml"), "tiers:\n  cheap: [m1]\n  strong: [m2, m3]\n");
    expect(loadBrainsConfig(join(dir, "BRAINS.yaml")).tiers.strong).toEqual(["m2", "m3"]);
  });
  it("routes tier to first model", async () => {
    const seen: string[] = [];
    const b = new Brains(cfg, async (req) => { seen.push(req.model as string); return textResponse; });
    const res = await b.complete({ tier: "cheap", messages: [{ role: "user", content: "hi" }] });
    expect(seen).toEqual(["model-a"]);
    expect(res.text).toBe("hello");
  });
  it("falls back to next model on failure", async () => {
    const seen: string[] = [];
    const b = new Brains(cfg, async (req) => {
      seen.push(req.model as string);
      if (req.model === "model-b") throw new Error("overloaded");
      return textResponse;
    });
    await b.complete({ tier: "strong", messages: [] });
    expect(seen).toEqual(["model-b", "model-c"]);
  });
  it("extracts tool calls", async () => {
    const b = new Brains(cfg, async () => ({ content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "tu_1", name: "echo", input: { value: 1 } }] }));
    const res = await b.complete({ tier: "cheap", messages: [] });
    expect(res.toolCalls).toEqual([{ id: "tu_1", name: "echo", input: { value: 1 } }]);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement**

```ts
// config.ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";
export type Tier = "cheap" | "strong";
export interface BrainsConfig { tiers: Record<Tier, string[]>; }
export function loadBrainsConfig(yamlPath: string): BrainsConfig {
  const cfg = parse(readFileSync(yamlPath, "utf8")) as BrainsConfig;
  for (const tier of ["cheap", "strong"] as Tier[]) {
    if (!cfg?.tiers?.[tier]?.length) throw new Error(`BRAINS.yaml: tier "${tier}" missing or empty`);
  }
  return cfg;
}
// router.ts
import Anthropic from "@anthropic-ai/sdk";
import type { BrainsConfig, Tier } from "./config.js";
export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown>; }
export interface ToolCall { id: string; name: string; input: Record<string, unknown>; }
export interface CompleteResult { text: string; toolCalls: ToolCall[]; assistantContent: unknown[]; }
export interface CompleteRequest { tier: Tier; system?: string; messages: unknown[]; tools?: ToolSpec[]; maxTokens?: number; }
type MessagesCreate = (req: Record<string, unknown>) => Promise<unknown>;

export class Brains {
  private call: MessagesCreate;
  constructor(private config: BrainsConfig, messagesCreate?: MessagesCreate) {
    this.call = messagesCreate ?? ((req) => new Anthropic().messages.create(req as never));
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    let lastErr: unknown = new Error("no models configured");
    for (const model of this.config.tiers[req.tier]) {
      try {
        const res = (await this.call({
          model, max_tokens: req.maxTokens ?? 1024, system: req.system,
          messages: req.messages, tools: req.tools,
        })) as { content: Array<Record<string, unknown>> };
        const text = res.content.filter(b => b.type === "text").map(b => b.text as string).join("");
        const toolCalls = res.content.filter(b => b.type === "tool_use")
          .map(b => ({ id: b.id as string, name: b.name as string, input: b.input as Record<string, unknown> }));
        return { text, toolCalls, assistantContent: res.content };
      } catch (err) { lastErr = err; }
    }
    throw lastErr;
  }
}
// index.ts
export * from "./config.js"; export * from "./router.js";
```

`workspace/BRAINS.yaml` (models are config, never code — spec rule):

```yaml
tiers:
  cheap: [claude-haiku-4-5-20251001]
  strong: [claude-opus-5, claude-sonnet-5]
```

- [ ] **Step 4: Run tests** — Expected: PASS. **Step 5: Commit** `feat(brains): tier router with fallback, BRAINS.yaml config`

---

### Task 7: Agent — the improviser

**Files:**
- Create: `packages/agent/src/improviser.ts`; Modify: `packages/agent/src/index.ts`; Test: `packages/agent/test/improviser.test.ts`; Create: `workspace/SOUL.md`

**Interfaces:**
- Consumes: `Brains.complete` (Task 6), `listNodes/getNode` + `Journal` (kernel).
- Produces: `export class Agent { constructor(opts: { brains: Brains; journal: Journal; tenantId: string; soul: string }); handleMessage(text: string): Promise<string>; }` — every tool call executes a registered node, is appended to a growing `Graph` (linear edges in call order) and recorded via `recordStep`; the whole exchange is ONE journal execution of kind `"improvised"`. Anthropic tool names can't contain dots: node `a.b` ↔ tool `a__b`.

- [ ] **Step 1: Failing test** — `packages/agent/test/improviser.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

function scriptedBrains(responses: unknown[]): Brains {
  let i = 0;
  return new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => responses[i++]);
}
describe("improviser", () => {
  beforeEach(() => { clearNodes(); registerBuiltinNodes(); });
  it("executes tool calls as journaled steps, then replies", async () => {
    const journal = new Journal(":memory:");
    const brains = scriptedBrains([
      { content: [{ type: "tool_use", id: "tu1", name: "echo", input: { value: "ping" } }] },
      { content: [{ type: "text", text: "done: ping" }] },
    ]);
    const agent = new Agent({ brains, journal, tenantId: "t1", soul: "You are a test agent." });
    const reply = await agent.handleMessage("please echo ping");
    expect(reply).toBe("done: ping");
    const [rec] = journal.list({ tenantId: "t1" });
    expect(rec.kind).toBe("improvised");
    expect(rec.status).toBe("ok");
    expect(rec.steps).toHaveLength(1);
    expect(rec.steps[0].node).toBe("echo");
    expect(rec.steps[0].output[0].json.value).toBe("ping");
    expect(rec.graph.nodes).toHaveLength(1);
  });
  it("maps dotted node names to legal tool names and back", async () => {
    const journal = new Journal(":memory:");
    const brains = scriptedBrains([
      { content: [{ type: "tool_use", id: "tu1", name: "http__request", input: { url: "http://x" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    // http.request will fail to fetch http://x — the step must be recorded as error, execution continues
    const agent = new Agent({ brains, journal, tenantId: "t1", soul: "s" });
    await agent.handleMessage("fetch x");
    const [rec] = journal.list();
    expect(rec.steps[0].node).toBe("http.request");
    expect(rec.steps[0].status).toBe("error");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** `improviser.ts`:

```ts
import { getNode, listNodes, type Graph, type Item, type Journal } from "@squidclaw/kernel";
import type { Brains, ToolSpec } from "@squidclaw/brains";

const toToolName = (nodeName: string) => nodeName.replaceAll(".", "__");
const toNodeName = (toolName: string) => toolName.replaceAll("__", ".");
const MAX_TURNS = 8;

export class Agent {
  constructor(private opts: { brains: Brains; journal: Journal; tenantId: string; soul: string }) {}

  async handleMessage(text: string): Promise<string> {
    const { brains, journal, tenantId, soul } = this.opts;
    const tools: ToolSpec[] = listNodes().map(n => ({
      name: toToolName(n.name), description: n.description, input_schema: n.inputSchema }));
    const graph: Graph = { nodes: [], edges: [] };
    const execId = journal.begin({ tenantId, kind: "improvised", graph });
    const messages: unknown[] = [{ role: "user", content: text }];
    let reply = "";
    let seq = 0;
    let prevNodeId: string | null = null;
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await brains.complete({ tier: "strong", system: soul, messages, tools });
        if (res.toolCalls.length === 0) { reply = res.text; break; }
        messages.push({ role: "assistant", content: res.assistantContent });
        const toolResults: unknown[] = [];
        for (const call of res.toolCalls) {
          const nodeName = toNodeName(call.name);
          const def = getNode(nodeName);
          const nodeId = `n${++seq}`;
          graph.nodes.push({ id: nodeId, node: nodeName, params: call.input });
          if (prevNodeId) graph.edges.push({ from: prevNodeId, to: nodeId });
          prevNodeId = nodeId;
          const startedAt = new Date().toISOString();
          let output: Item[] = [];
          let error: string | undefined;
          try {
            if (!def) throw new Error(`Unknown node: ${nodeName}`);
            output = await def.run(call.input, [], { tenantId });
          } catch (err) { error = String(err); }
          journal.recordStep(execId, { nodeId, node: nodeName, params: call.input, input: [], output,
            status: error ? "error" : "ok", error, startedAt, finishedAt: new Date().toISOString() });
          toolResults.push({ type: "tool_result", tool_use_id: call.id, is_error: !!error,
            content: error ?? JSON.stringify(output.slice(0, 5).map(i => i.json)) });
        }
        messages.push({ role: "user", content: toolResults });
      }
      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      return reply || "(I ran out of thinking turns — check the journal.)";
    } catch (err) {
      journal.setGraph(execId, graph);
      journal.finish(execId, "error");
      return `Something went wrong: ${String(err)}`;
    }
  }
}
```

`index.ts`: `export * from "./improviser.js";`
`workspace/SOUL.md`:

```markdown
# SOUL
You are SquidClaw — a habit-forming agent. You complete tasks by calling tools.
Prefer acting over explaining. When a task is done, reply with one short,
plain-language sentence describing the result. Never invent tool results.
```

- [ ] **Step 4: Run tests** — Expected: PASS. **Step 5: Commit** `feat(agent): improviser — tool calls journaled as improvised executions`

---

### Task 8: Surfaces — ChatSurface + Telegram

**Files:**
- Create: `packages/surfaces/src/surface.ts`, `packages/surfaces/src/telegram.ts`; Modify: `packages/surfaces/src/index.ts`; Test: `packages/surfaces/test/telegram.test.ts`

**Interfaces:**
- Produces: `export type MessageHandler = (chatId: string, text: string) => Promise<string>;` `export interface ChatSurface { start(): Promise<void>; stop(): Promise<void>; }` `export class TelegramSurface implements ChatSurface { constructor(token: string, onMessage: MessageHandler); readonly bot: Bot; }` — incoming `message:text` → handler → `ctx.reply(result)`; handler errors are caught and replied as `"⚠️ " + message`.

- [ ] **Step 1: Failing test** — `packages/surfaces/test/telegram.test.ts` (grammY offline: inject `botInfo`, capture outgoing API calls with a transformer, feed updates via `handleUpdate`):

```ts
import { describe, it, expect } from "vitest";
import { TelegramSurface } from "@squidclaw/surfaces";

function fakeUpdate(text: string) {
  return { update_id: 1, message: { message_id: 10, date: 0, text,
    chat: { id: 77, type: "private" as const }, from: { id: 77, is_bot: false, first_name: "T" } } };
}
const botInfo = { id: 1, is_bot: true as const, first_name: "sq", username: "sq_bot",
  can_join_groups: true as const, can_read_all_group_messages: false as const,
  supports_inline_queries: false as const, can_connect_to_business: false as const,
  has_main_web_app: false as const };

describe("telegram surface", () => {
  it("routes text to handler and replies", async () => {
    const surface = new TelegramSurface("test-token", async (chatId, text) => `echo:${chatId}:${text}`, botInfo);
    const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
    surface.bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true as const, result: true as never };
    });
    await surface.bot.handleUpdate(fakeUpdate("hi"));
    expect(sent[0].method).toBe("sendMessage");
    expect(sent[0].payload.text).toBe("echo:77:hi");
  });
  it("replies with warning on handler error", async () => {
    const surface = new TelegramSurface("test-token", async () => { throw new Error("db down"); }, botInfo);
    const sent: Array<{ payload: Record<string, unknown> }> = [];
    surface.bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ payload: payload as Record<string, unknown> });
      return { ok: true as const, result: true as never };
    });
    await surface.bot.handleUpdate(fakeUpdate("hi"));
    expect(String(sent[0].payload.text)).toContain("⚠️");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement**

```ts
// surface.ts
export type MessageHandler = (chatId: string, text: string) => Promise<string>;
export interface ChatSurface { start(): Promise<void>; stop(): Promise<void>; }
// telegram.ts
import { Bot, type BotConfig } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ChatSurface, MessageHandler } from "./surface.js";

export class TelegramSurface implements ChatSurface {
  readonly bot: Bot;
  constructor(token: string, onMessage: MessageHandler, botInfo?: UserFromGetMe) {
    const config: BotConfig<never> | undefined = botInfo ? { botInfo } : undefined;
    this.bot = new Bot(token, config as never);
    this.bot.on("message:text", async (ctx) => {
      try {
        const reply = await onMessage(String(ctx.chat.id), ctx.message.text);
        await ctx.reply(reply);
      } catch (err) {
        await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  async start(): Promise<void> { void this.bot.start(); }
  async stop(): Promise<void> { await this.bot.stop(); }
}
// index.ts
export * from "./surface.js"; export * from "./telegram.js";
```

- [ ] **Step 4: Run tests** — Expected: PASS. **Step 5: Commit** `feat(surfaces): ChatSurface + telegram long-polling surface`

---

### Task 9: Server — dev runner + journal CLI

**Files:**
- Create: `packages/server/src/dev.ts`, `packages/server/src/cli.ts`

**Interfaces:**
- Consumes: everything above. Produces: `npm run dev` (live agent on Telegram), `npm run journal -- list` / `npm run journal -- show <id>`.

- [ ] **Step 1: dev.ts**

```ts
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains, loadBrainsConfig } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";
import { TelegramSurface } from "@squidclaw/surfaces";

const WORKSPACE = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN missing — copy .env.example to .env"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY missing"); process.exit(1); }

registerBuiltinNodes();
const journal = new Journal(join(WORKSPACE, "journal", "executions.db"));
const brains = new Brains(loadBrainsConfig(join(WORKSPACE, "BRAINS.yaml")));
const soul = readFileSync(join(WORKSPACE, "SOUL.md"), "utf8");
const agent = new Agent({ brains, journal, tenantId: "dev", soul });
const surface = new TelegramSurface(token, (_chatId, text) => agent.handleMessage(text));
await surface.start();
console.log("SquidClaw heartbeat: listening on Telegram (long-polling). Ctrl+C to stop.");
```

- [ ] **Step 2: cli.ts**

```ts
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
const WORKSPACE = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");
const journal = new Journal(join(WORKSPACE, "journal", "executions.db"));
const [cmd, arg] = process.argv.slice(2);
if (cmd === "list") {
  for (const e of journal.list({ limit: 20 })) {
    console.log(`${e.id}  ${e.status.padEnd(7)} ${e.kind.padEnd(10)} steps=${e.steps.length}  ${e.startedAt}  [${e.tenantId}]`);
  }
} else if (cmd === "show" && arg) {
  const e = journal.get(arg);
  if (!e) { console.error("not found"); process.exit(1); }
  console.log(JSON.stringify(e, null, 2));
} else {
  console.log("usage: npm run journal -- list | show <executionId>");
}
```

- [ ] **Step 3: Typecheck + full test suite** — Run: `npm run typecheck && npm test` — Expected: clean, all green.
- [ ] **Step 4: Commit** `feat(server): dev runner + journal CLI`

---

### Task 10: Live heartbeat verification (manual, with Tamer)

**Files:** none (verification only). Prereqs: `.env` filled with real `ANTHROPIC_API_KEY` + `TELEGRAM_BOT_TOKEN`.

- [ ] **Step 1:** `npm run dev` → expect the heartbeat banner, no errors.
- [ ] **Step 2:** From Telegram, message the dev bot: `fetch https://api.github.com/zen and tell me what it says`
- [ ] **Step 3:** Expect a natural-language reply containing the fetched zen phrase (proves: surface → agent → brains → http.request node → reply).
- [ ] **Step 4:** `npm run journal -- list` → expect one `improvised` execution, status `ok`, steps ≥ 1. `npm run journal -- show <id>` → verify the `http.request` step shows real input/output. **This is Phase 1's "alive when" criterion — met.**
- [ ] **Step 5:** Commit any fixes found; push: `git push` (Tamer runs it if permission-blocked).

---

### Task 11: Deploy dev instance to Preplix VPS — ⚠️ GATED: requires Tamer's explicit go

**Files:** none locally. Target: `/opt/agenticflow` on preplix-prod, localhost-only (long-polling ⇒ no ports, no nginx, no DNS).

- [ ] **Step 1:** Ask Tamer for explicit go (production box). STOP until received.
- [ ] **Step 2:** `ssh preplix-prod "git clone git@github.com:ttaaamm/squidclaw.git /opt/agenticflow && cd /opt/agenticflow && npm ci"` (server's existing GitHub auth; if the clone fails on SSH auth, fall back to HTTPS with the stored credential).
- [ ] **Step 3:** Create `/opt/agenticflow/.env` on the server (Tamer supplies values; never echoed to terminal output).
- [ ] **Step 4:** Run under tmux for now (systemd unit is Phase 3): `ssh preplix-prod "cd /opt/agenticflow && tmux new -d -s squidclaw 'npx tsx packages/server/src/dev.ts'"`
- [ ] **Step 5:** Repeat Task 10's Telegram verification against the VPS instance; stop the local one first (two pollers on one bot token steal each other's updates).

---

## Self-Review Notes

- Spec coverage: kernel (§3 ✓ Tasks 2–4), brains (§4 ✓ Task 6), agent-improvise + journal-as-graph (§1 ✓ Task 7), Telegram surface (§5 ✓ Task 8), tenant_id everywhere (✓ journal schema + NodeContext), tool-manifest shape (✓ NodeDef→ToolSpec), no hardcoded models (✓ BRAINS.yaml), runs-anywhere (✓ env/config only). Crystallization, reflexes, healing, canvas = Phases 2–4, intentionally absent.
- Type consistency: `Item/NodeDef/Graph/StepRecord` defined once in Task 2, consumed verbatim in 3–9. Tool-name mapping `.`↔`__` defined in Task 7 and tested.
- Known simplifications (deliberate, Phase-1-honest): improvised tool calls get `input: []` (agent passes data via params); binary items serialize naively in the journal; no queue/concurrency; single tenant `"dev"`.
