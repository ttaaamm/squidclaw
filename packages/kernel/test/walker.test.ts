import { describe, it, expect, beforeEach } from "vitest";
import { registerNode, clearNodes, Journal, executeGraph, type Graph, type Item } from "@squidclaw/kernel";

describe("graph walker", () => {
  beforeEach(() => {
    clearNodes();
    registerNode({
      name: "emit", description: "emits params.value", inputSchema: {},
      run: async (p) => [{ json: { value: p.value } }],
    });
    registerNode({
      name: "upper", description: "uppercases value of each item", inputSchema: {},
      run: async (_p, items: Item[]) => items.map((i) => ({ json: { value: String(i.json.value).toUpperCase() } })),
    });
    registerNode({
      name: "boom", description: "always throws", inputSchema: {},
      run: async () => { throw new Error("boom"); },
    });
  });

  it("walks a chain, items flow, journal records steps", async () => {
    const g: Graph = {
      nodes: [
        { id: "a", node: "emit", params: { value: "hi" } },
        { id: "b", node: "upper", params: {} },
      ],
      edges: [{ from: "a", to: "b" }],
    };
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
