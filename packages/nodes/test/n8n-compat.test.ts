import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { branchesOf, clearNodes, executeGraph, registerNode, Journal, type Item } from "@squidclaw/kernel";
import { n8nStepNode, importN8nWorkflow, resolveExpr, evalConditions, registerBuiltinNodes } from "@squidclaw/nodes";

const ctx = { tenantId: "t" };
const item = (json: Record<string, unknown>): Item => ({ json });

beforeEach(() => {
  process.env.SQUIDCLAW_STATIC_DIR = mkdtempSync(join(tmpdir(), "static-"));
});

describe("n8n expressions", () => {
  it("interpolates {{ }} against $json, keeping types for single expressions", () => {
    const it1 = item({ amount: 500, client: "Al Jood" });
    expect(resolveExpr("=Invoice for {{ $json.client }}", it1, [it1], ctx)).toBe("Invoice for Al Jood");
    expect(resolveExpr("={{ $json.amount * 2 }}", it1, [it1], ctx)).toBe(1000); // real number
    expect(resolveExpr("plain string", it1, [it1], ctx)).toBe("plain string");
  });

  it("reaches back to other nodes via $('Name')", () => {
    const outputs = new Map([["fetch-1", [[item({ zen: "Design for failure." })]]]]);
    const nodeIds = new Map([["Fetch Zen", "fetch-1"]]);
    const scoped = { tenantId: "t", outputs, nodeIds };
    expect(resolveExpr("={{ $('Fetch Zen').json.zen }}", item({}), [], scoped)).toBe("Design for failure.");
  });
});

describe("n8n conditions", () => {
  it("evaluates operators with and/or combinators", () => {
    const it1 = item({ status: "paid", amount: 900 });
    const paid = {
      conditions: [{ leftValue: "={{ $json.status }}", rightValue: "paid", operator: { operation: "equals" } }],
    };
    expect(evalConditions(paid, it1, [it1], ctx)).toBe(true);

    const bigOrPaid = {
      combinator: "or",
      conditions: [
        { leftValue: "={{ $json.amount }}", rightValue: 1000, operator: { operation: "gt" } },
        { leftValue: "={{ $json.status }}", rightValue: "paid", operator: { operation: "equals" } },
      ],
    };
    expect(evalConditions(bigOrPaid, it1, [it1], ctx)).toBe(true);
  });
});

describe("n8n.step — the dialect", () => {
  it("runs a Code node with $input, $json and staticData that persists", async () => {
    const params = {
      type: "n8n-nodes-base.code",
      __flow: "test-flow",
      parameters: {
        jsCode: `
          const data = $getWorkflowStaticData('global');
          data.counter = (data.counter ?? 100) + 1;
          return [{ json: { invoiceNo: data.counter, client: $json.client } }];
        `,
      },
    };
    const first = await n8nStepNode.run(params, [item({ client: "Al Jood" })], ctx);
    expect(first[0].json).toEqual({ invoiceNo: 101, client: "Al Jood" });

    const second = await n8nStepNode.run(params, [item({ client: "Al Jood" })], ctx);
    expect(second[0].json.invoiceNo).toBe(102); // the counter survived — n8n's fragile bit, kept
  });

  it("IF routes items into true/false branches", async () => {
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.if",
        parameters: {
          conditions: {
            conditions: [{ leftValue: "={{ $json.ok }}", rightValue: true, operator: { operation: "true" } }],
          },
        },
      },
      [item({ ok: true, id: 1 }), item({ ok: false, id: 2 })],
      ctx,
    );
    const branches = branchesOf(out)!;
    expect(branches[0].map((i) => i.json.id)).toEqual([1]);
    expect(branches[1].map((i) => i.json.id)).toEqual([2]);
  });

  it("Set assigns resolved values onto items", async () => {
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.set",
        parameters: {
          assignments: { assignments: [{ name: "greeting", value: "=Hello {{ $json.name }}" }] },
        },
      },
      [item({ name: "Tamer" })],
      ctx,
    );
    expect(out[0].json.greeting).toBe("Hello Tamer");
    expect(out[0].json.name).toBe("Tamer");
  });

  it("extractFromFile turns binary into text", async () => {
    const out = await n8nStepNode.run(
      { type: "n8n-nodes-base.extractFromFile", parameters: { destinationKey: "html" } },
      [{ json: {}, binary: { data: Buffer.from("<h1>hi</h1>") } }],
      ctx,
    );
    expect(out[0].json.html).toBe("<h1>hi</h1>");
  });

  it("names the type honestly when the dialect doesn't speak it", async () => {
    await expect(
      n8nStepNode.run({ type: "n8n-nodes-base.googleSheets", parameters: {} }, [], ctx),
    ).rejects.toThrow(/no native support yet/);
  });
});

describe("importing real shapes", () => {
  it("preserves IF branch wiring as branch-tagged edges", () => {
    const { graph, unsupported } = importN8nWorkflow({
      name: "branchy",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger" },
        { name: "Check", type: "n8n-nodes-base.if", parameters: {} },
        { name: "Yes", type: "n8n-nodes-base.noOp" },
        { name: "No", type: "n8n-nodes-base.noOp" },
      ],
      connections: {
        Start: { main: [[{ node: "Check" }]] },
        Check: { main: [[{ node: "Yes" }], [{ node: "No" }]] },
      },
    });
    expect(unsupported).toEqual([]);
    expect(graph.nodes.every((n) => n.node === "n8n.step")).toBe(true);
    const toNo = graph.edges.find((e) => e.to.startsWith("no-"))!;
    expect(toNo.branch).toBe(1); // the false path
    const toYes = graph.edges.find((e) => e.to.startsWith("yes-"))!;
    expect(toYes.branch).toBeUndefined(); // branch 0
  });

  it("drops sticky notes and reports truly unknown types", () => {
    const { graph, unsupported } = importN8nWorkflow({
      nodes: [
        { name: "Note", type: "n8n-nodes-base.stickyNote" },
        { name: "Sheet", type: "n8n-nodes-base.googleSheets" },
      ],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(unsupported).toEqual([{ node: "Sheet", type: "n8n-nodes-base.googleSheets" }]);
  });
});

describe("a branched flow, end to end through the kernel", () => {
  it("routes each item down its own path", async () => {
    clearNodes();
    registerBuiltinNodes();
    const seen: Record<string, number[]> = { yes: [], no: [] };
    registerNode({
      name: "collect.yes", description: "", inputSchema: {},
      run: async (_p, items) => { seen.yes = items.map((i) => Number(i.json.id)); return items; },
    });
    registerNode({
      name: "collect.no", description: "", inputSchema: {},
      run: async (_p, items) => { seen.no = items.map((i) => Number(i.json.id)); return items; },
    });

    const rec = await executeGraph(
      {
        nodes: [
          {
            id: "check", node: "n8n.step",
            params: {
              type: "n8n-nodes-base.if",
              parameters: { conditions: { conditions: [{ leftValue: "={{ $json.big }}", operator: { operation: "true" } }] } },
            },
          },
          { id: "yes", node: "collect.yes", params: {} },
          { id: "no", node: "collect.no", params: {} },
        ],
        edges: [
          { from: "check", to: "yes" },
          { from: "check", to: "no", branch: 1 },
        ],
      },
      {
        tenantId: "t", kind: "flow", journal: new Journal(":memory:"),
        seedItems: [item({ big: true, id: 1 }), item({ big: false, id: 2 }), item({ big: true, id: 3 })],
      },
    );

    expect(rec.status).toBe("ok");
    expect(seen.yes).toEqual([1, 3]);
    expect(seen.no).toEqual([2]);
  });
});
