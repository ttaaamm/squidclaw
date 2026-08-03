import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal, type Graph } from "@squidclaw/kernel";
import { FlowStore } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { layoutGraph, rankNodes, detail, summarize, DashboardServer, type Sources } from "@squidclaw/canvas";

const chain: Graph = {
  nodes: [
    { id: "a", node: "web.search", params: { query: "x" } },
    { id: "b", node: "web.read", params: {} },
    { id: "c", node: "pdf.create", params: {} },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ],
};

const fanOut: Graph = {
  nodes: [
    { id: "a", node: "start", params: {} },
    { id: "b", node: "left", params: {} },
    { id: "c", node: "right", params: {} },
    { id: "d", node: "join", params: {} },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "d" },
  ],
};

describe("laying out a graph", () => {
  it("ranks a chain left to right", () => {
    const rank = rankNodes(chain);
    expect([rank.get("a"), rank.get("b"), rank.get("c")]).toEqual([0, 1, 2]);
  });

  it("puts parallel branches in the same column, and the join after both", () => {
    const rank = rankNodes(fanOut);
    expect(rank.get("b")).toBe(1);
    expect(rank.get("c")).toBe(1);
    expect(rank.get("d")).toBe(2);
  });

  it("places every node and draws every edge", () => {
    const l = layoutGraph(fanOut);
    expect(l.nodes).toHaveLength(4);
    expect(l.edges).toHaveLength(4);
    expect(l.edges[0].path).toMatch(/^M [\d.]+ [\d.]+ C /);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it("stacks same-rank nodes without overlapping them", () => {
    const l = layoutGraph(fanOut);
    const [b, c] = [l.nodes.find((n) => n.id === "b")!, l.nodes.find((n) => n.id === "c")!];
    expect(b.x).toBe(c.x);
    expect(Math.abs(b.y - c.y)).toBeGreaterThanOrEqual(b.height);
  });

  it("survives an empty graph and a cyclic one", () => {
    expect(layoutGraph({ nodes: [], edges: [] }).nodes).toEqual([]);
    const cyclic: Graph = {
      nodes: [{ id: "a", node: "x", params: {} }, { id: "b", node: "y", params: {} }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    };
    expect(layoutGraph(cyclic).nodes).toHaveLength(2); // placed, not dropped
  });

  it("ignores edges pointing at nodes that aren't there", () => {
    const broken: Graph = { nodes: [{ id: "a", node: "x", params: {} }], edges: [{ from: "a", to: "ghost" }] };
    expect(layoutGraph(broken).edges).toEqual([]);
  });
});

describe("describing a run", () => {
  it("summarizes shape, status and duration", () => {
    const journal = new Journal(":memory:");
    const id = journal.begin({ tenantId: "dev", kind: "improvised", graph: chain });
    journal.recordStep(id, {
      nodeId: "a", node: "web.search", params: {}, input: [], output: [{ json: { hit: 1 } }],
      status: "ok", startedAt: "2026-08-03T00:00:00Z", finishedAt: "2026-08-03T00:00:02Z",
    });
    journal.finish(id, "ok");

    const s = summarize(journal.get(id)!);
    expect(s.shape).toBe("web.search → web.read → pdf.create");
    expect(s.status).toBe("ok");
    expect(s.steps).toBe(1);
    expect(s.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marries recorded steps to the graph, exposing what went in and out", () => {
    const journal = new Journal(":memory:");
    const id = journal.begin({ tenantId: "dev", kind: "flow", graph: chain });
    journal.recordStep(id, {
      nodeId: "b", node: "web.read", params: {}, input: [{ json: { url: "u" } }],
      output: [{ json: { text: "hello" } }], status: "error", error: "boom",
      startedAt: "2026-08-03T00:00:00Z", finishedAt: "2026-08-03T00:00:01Z",
    });
    journal.finish(id, "error");

    const d = detail(journal.get(id)!);
    const b = d.nodes.find((n) => n.id === "b")!;
    expect(b.status).toBe("error");
    expect(b.error).toBe("boom");
    expect(b.input).toEqual([{ url: "u" }]);
    expect(b.output).toEqual([{ text: "hello" }]);
    expect(b.durationMs).toBe(1000);

    const notRun = d.nodes.find((n) => n.id === "a")!;
    expect(notRun.status).toBeUndefined();
    expect(d.layout.nodes).toHaveLength(3);
  });
});

describe("the dashboard server", () => {
  let server: DashboardServer;
  let port: number;
  let src: Sources;
  let journal: Journal;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-"));
    journal = new Journal(":memory:");
    const flows = new FlowStore(join(dir, "flows"));
    flows.saveDraft({
      name: "fetch-zen", description: "fetches zen", signature: "http.request",
      triggers: ["fetch the zen"], params: ["url"], runs: 2, createdAt: "now", status: "draft",
      graph: { nodes: [{ id: "n1", node: "http.request", params: { url: "{{url}}" } }], edges: [] },
    });
    flows.promote("fetch-zen");

    const reflexes = new ReflexStore(join(dir, "reflexes"));
    reflexes.save({ name: "daily", flow: "fetch-zen", cron: "0 9 * * *", enabled: true, createdAt: "now" });

    src = { journal, flows, reflexes, mind: { via: "cli", tools: 12 }, tenantId: "dev" };
    server = new DashboardServer(src, { pollMs: 50 });
    port = await server.listen(0);
  });

  afterEach(async () => server.close());

  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  it("serves a self-contained page", async () => {
    const res = await get("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("SquidClaw");
    expect(html).not.toMatch(/<script[^>]+src=/); // nothing to fetch, nothing to build
  });

  it("reports the state of the mind", async () => {
    const state = await (await get("/api/state")).json();
    expect(state.mind).toEqual({ via: "cli", tools: 12 });
    expect(state.habits.map((h: { name: string }) => h.name)).toEqual(["fetch-zen"]);
    expect(state.reflexes[0].name).toBe("daily");
    expect(state.counts.habits).toBe(1);
    expect(state.counts.reflexes).toBe(1);
  });

  it("lists executions and serves one in full", async () => {
    const id = journal.begin({ tenantId: "dev", kind: "improvised", graph: chain });
    journal.finish(id, "ok");

    const list = await (await get("/api/executions")).json();
    expect(list[0].id).toBe(id);
    expect(list[0].shape).toContain("web.search");

    const one = await (await get(`/api/executions/${id}`)).json();
    expect(one.layout.nodes).toHaveLength(3);
    expect(one.nodes[0].node).toBe("web.search");
  });

  it("serves a habit with its graph laid out", async () => {
    const habit = await (await get("/api/habits/fetch-zen")).json();
    expect(habit.name).toBe("fetch-zen");
    expect(habit.params).toEqual(["url"]);
    expect(habit.layout.nodes).toHaveLength(1);
    expect(habit.triggers).toContain("fetch the zen");
  });

  it("404s things that aren't there", async () => {
    expect((await get("/api/executions/nope")).status).toBe(404);
    expect((await get("/api/habits/nope")).status).toBe(404);
    expect((await get("/nothing")).status).toBe(404);
  });

  it("streams new executions to a watching page", async () => {
    const res = await get("/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const id = journal.begin({ tenantId: "dev", kind: "flow", graph: chain });
    journal.finish(id, "ok");

    let text = "";
    // The first push carries the new run; give the poller a couple of ticks.
    for (let i = 0; i < 4 && !text.includes(id); i++) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("data:");
    expect(text).toContain(id);
    await reader.cancel();
  }, 15_000);
});
