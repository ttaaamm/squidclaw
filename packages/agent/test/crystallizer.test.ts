import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, getNode, registerNode, Journal, type Graph } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { ConversationStore } from "@squidclaw/memory";
import {
  Agent, FlowStore, crystallize, findRepeatedWork, graphSignature, nameFor, parameterize, renderGraph,
} from "@squidclaw/agent";

const dir = () => mkdtempSync(join(tmpdir(), "flows-"));

const graph = (url: string): Graph => ({
  nodes: [
    { id: "n1", node: "web.search", params: { query: url, limit: 5 } },
    { id: "n2", node: "http.request", params: { url: `https://api/${url}`, method: "GET" } },
  ],
  edges: [{ from: "n1", to: "n2" }],
});

describe("recognising the same work twice", () => {
  it("signs a graph by its shape", () => {
    expect(graphSignature(graph("a"))).toBe("web.search|http.request");
    expect(nameFor(graph("a"))).toBe("web-search-http-request");
  });

  it("finds work repeated across the journal, ignoring failures and one-offs", () => {
    const journal = new Journal(":memory:");
    for (const url of ["a", "b"]) {
      const id = journal.begin({ tenantId: "t", kind: "improvised", graph: graph(url) });
      journal.finish(id, "ok");
    }
    const failed = journal.begin({ tenantId: "t", kind: "improvised", graph: graph("c") });
    journal.finish(failed, "error");
    const once = journal.begin({
      tenantId: "t", kind: "improvised",
      graph: { nodes: [{ id: "x", node: "echo", params: {} }], edges: [] },
    });
    journal.finish(once, "ok");

    const found = findRepeatedWork(journal, "t");
    expect(found).toHaveLength(1);
    expect(found[0].signature).toBe("web.search|http.request");
    expect(found[0].executions).toHaveLength(2);
  });

  it("refuses to make a habit out of pure remembering", () => {
    const journal = new Journal(":memory:");
    for (let i = 0; i < 3; i++) {
      const id = journal.begin({
        tenantId: "t", kind: "improvised",
        graph: { nodes: [{ id: "n1", node: "memory.remember", params: { name: `f${i}` } }], edges: [] },
      });
      journal.finish(id, "ok");
    }
    expect(findRepeatedWork(journal, "t")).toEqual([]);
  });
});

describe("freezing what stayed, opening what changed", () => {
  it("bakes in constants and parameterizes the differences", () => {
    const { graph: frozen, params } = parameterize([graph("alpha"), graph("beta")]);
    // Params are named after the field that varied — "query", not "web_search".
    expect(params).toEqual(["query", "url"]);
    expect(frozen.nodes[0].params).toEqual({ query: "{{query}}", limit: 5 });
    expect(frozen.nodes[1].params).toEqual({ url: "{{url}}", method: "GET" });
    expect(frozen.edges).toEqual([{ from: "n1", to: "n2" }]);
  });

  it("keeps everything literal when nothing varied", () => {
    const { params, graph: frozen } = parameterize([graph("same"), graph("same")]);
    expect(params).toEqual([]);
    expect(frozen.nodes[0].params).toEqual({ query: "same", limit: 5 });
  });

  it("descends into nested objects", () => {
    const nested = (v: string): Graph => ({
      nodes: [{ id: "n1", node: "http.request", params: { url: "u", body: { to: v, from: "me" } } }],
      edges: [],
    });
    const { graph: frozen } = parameterize([nested("x"), nested("y")]);
    expect(frozen.nodes[0].params.body).toEqual({ to: "{{to}}", from: "me" });
  });
});

describe("filling a habit in", () => {
  it("substitutes placeholders and preserves argument types", () => {
    const filled = renderGraph(
      {
        nodes: [
          { id: "n1", node: "a", params: { q: "{{topic}}", limit: 5, note: "about {{topic}}" } },
          { id: "n2", node: "b", params: { count: "{{n}}" } },
        ],
        edges: [],
      },
      { topic: "n8n", n: 42 },
    );
    expect(filled.nodes[0].params).toEqual({ q: "n8n", limit: 5, note: "about n8n" });
    expect(filled.nodes[1].params.count).toBe(42); // a lone placeholder keeps its type
  });
});

describe("the flow store", () => {
  it("keeps drafts apart from promoted habits until a human says yes", () => {
    const store = new FlowStore(dir());
    const flow = crystallize(
      { signature: "web.search|http.request", executions: [{ graph: graph("x") }] as never },
      ["do the thing"],
    );
    store.saveDraft({ ...flow, name: "my-habit" });

    expect(store.drafts().map((f) => f.name)).toEqual(["my-habit"]);
    expect(store.promoted()).toEqual([]);

    expect(store.promote("my-habit")).toBe(true);
    expect(store.promoted().map((f) => f.name)).toEqual(["my-habit"]);
    expect(store.drafts()).toEqual([]);
    expect(store.promote("nonexistent")).toBe(false);
  });
});

describe("a habit, dressed as a tool", () => {
  beforeEach(clearNodes);

  it("runs deterministically with no thinking at all", async () => {
    const calls: Record<string, unknown>[] = [];
    registerNode({
      name: "web.search", description: "search", inputSchema: {},
      run: async (p) => {
        calls.push(p);
        return [{ json: { hit: `result for ${p.query}` } }];
      },
    });

    const store = new FlowStore(dir());
    store.saveDraft({
      name: "search-it", description: "searches", signature: "web.search", triggers: [],
      params: ["topic"], runs: 2, createdAt: "now", status: "draft",
      graph: { nodes: [{ id: "n1", node: "web.search", params: { query: "{{topic}}" } }], edges: [] },
    });
    store.promote("search-it");

    // No Mind is given — proof that running a habit needs no brain at all.
    const agent = new Agent({
      brains: null as never, journal: new Journal(":memory:"), tenantId: "t", innerMe: "", flows: store,
    });
    // The constructor already wired habits in; calling again is a no-op.
    expect(agent.registerHabits()).toEqual([]);
    expect(getNode("flow.search-it")).toBeDefined();

    const out = await getNode("flow.search-it")!.run({ topic: "squid" }, [], { tenantId: "t" });
    expect(calls).toEqual([{ query: "squid" }]);
    expect(out[0].json.hit).toBe("result for squid");
  });

  it("surfaces a failing habit instead of pretending it worked", async () => {
    registerNode({
      name: "boom", description: "breaks", inputSchema: {},
      run: async () => { throw new Error("upstream down"); },
    });
    const store = new FlowStore(dir());
    store.saveDraft({
      name: "fragile", description: "d", signature: "boom", triggers: [], params: [],
      runs: 2, createdAt: "now", status: "draft",
      graph: { nodes: [{ id: "n1", node: "boom", params: {} }], edges: [] },
    });
    store.promote("fragile");

    new Agent({ brains: null as never, journal: new Journal(":memory:"), tenantId: "t", innerMe: "", flows: store });
    await expect(getNode("flow.fragile")!.run({}, [], { tenantId: "t" })).rejects.toThrow(/upstream down/);
  });
});

describe("the agent forms a habit on its own", () => {
  beforeEach(clearNodes);

  it("writes a draft after doing the same work twice, and asks before automating", async () => {
    registerNode({
      name: "http.request", description: "fetch", inputSchema: {},
      run: async (p) => [{ json: { fetched: p.url } }],
    });

    const flowsDir = dir();
    const store = new FlowStore(flowsDir);
    const journal = new Journal(":memory:");
    const conversation = new ConversationStore(":memory:");

    // A mind that always fetches, then reports.
    let call = 0;
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => {
      call++;
      return call % 2 === 1
        ? { content: [{ type: "tool_use", id: `t${call}`, name: "http__request", input: { url: `https://x/${call}` } }] }
        : { content: [{ type: "text", text: "fetched it" }] };
    });

    const agent = new Agent({
      brains, journal, conversation, flows: store, tenantId: "dev", innerMe: "I am SquidClaw.",
    });

    const first = await agent.handleMessage("fetch the first thing", "c1");
    expect(first).toBe("fetched it");
    expect(store.drafts()).toEqual([]); // once is not a habit

    const second = await agent.handleMessage("fetch the second thing", "c1");
    expect(second).toContain("I've done this 2 times");
    expect(second).toContain("/promote http-request");

    const [draft] = store.drafts();
    expect(draft.name).toBe("http-request");
    expect(draft.signature).toBe("http.request");
    expect(draft.params).toEqual(["url"]);
    expect(draft.graph.nodes[0].params).toEqual({ url: "{{url}}" });
    expect(draft.triggers).toContain("fetch the second thing");

    // It stays a draft — nothing automates itself.
    expect(store.promoted()).toEqual([]);
    const saved = JSON.parse(readFileSync(join(flowsDir, "_drafts", "http-request.flow.json"), "utf8")) as {
      status: string;
    };
    expect(saved.status).toBe("draft");

    // And it doesn't nag about the same habit again.
    const third = await agent.handleMessage("fetch a third thing", "c1");
    expect(third).not.toContain("I've done this");
  });
});
