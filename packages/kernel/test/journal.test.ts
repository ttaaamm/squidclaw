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
    expect(j.list({ tenantId: "t1" }).map((e) => e.id)).toEqual([a]);
    expect(j.list()).toHaveLength(2);
  });
});
