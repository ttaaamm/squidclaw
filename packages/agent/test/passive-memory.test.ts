import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { SemanticMemory } from "@squidclaw/memory";
import { Agent } from "@squidclaw/agent";

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("the passive ear (fact extraction)", () => {
  it("quietly remembers durable facts from an ordinary exchange", async () => {
    const memory = new SemanticMemory(mkdtempSync(join(tmpdir(), "ear-")));
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      // The extraction pass arrives on the cheap tier with the JSON instruction.
      if (String(req.system).includes('"facts"')) {
        return {
          content: [{ type: "text", text: '{"facts":[{"name":"brother","content":"The human\'s brother is named Omar."}]}' }],
        };
      }
      return { content: [{ type: "text", text: "Nice — say hi to Omar." }] };
    });

    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "", memory });
    await agent.handleMessage("my brother Omar is visiting tomorrow");
    await flush();

    expect(memory.recall("omar")[0]?.content).toContain("Omar");
  });

  it("a broken extraction never breaks the conversation", async () => {
    const memory = new SemanticMemory(mkdtempSync(join(tmpdir(), "ear-")));
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      if (String(req.system).includes('"facts"')) throw new Error("extractor died");
      return { content: [{ type: "text", text: "all good" }] };
    });

    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "", memory });
    expect(await agent.handleMessage("hello")).toBe("all good");
    await flush();
    expect(memory.all()).toEqual([]);
  });

  it("can be switched off", async () => {
    const memory = new SemanticMemory(mkdtempSync(join(tmpdir(), "ear-")));
    let extractionCalls = 0;
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      if (String(req.system).includes('"facts"')) extractionCalls++;
      return { content: [{ type: "text", text: "ok" }] };
    });

    const agent = new Agent({
      brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "", memory, extractFacts: false,
    });
    await agent.handleMessage("my sister is Sara");
    await flush();
    expect(extractionCalls).toBe(0);
  });
});

describe("the auto-link reader", () => {
  beforeEach(clearNodes);

  it("reads a pasted URL into context before thinking, and journals the fetch", async () => {
    registerNode({
      name: "web.read", description: "reads", inputSchema: {},
      run: async (p) => [{ json: { url: p.url, text: "The article says squid are brilliant." } }],
    });

    let seenContent = "";
    const journal = new Journal(":memory:");
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      const messages = req.messages as Array<{ content: unknown }>;
      seenContent = String(messages.at(-1)?.content ?? "");
      return { content: [{ type: "text", text: "summarised" }] };
    });

    const agent = new Agent({ brains, journal, tenantId: "t", innerMe: "" });
    await agent.handleMessage("what does https://example.com/squid say?");

    expect(seenContent).toContain("squid are brilliant"); // page arrived with the question
    const [rec] = journal.list();
    expect(rec.steps[0].node).toBe("web.read");
    expect(rec.steps[0].params.auto).toBe(true);
  });

  it("a dead link never blocks the answer", async () => {
    registerNode({
      name: "web.read", description: "reads", inputSchema: {},
      run: async () => { throw new Error("ECONNREFUSED"); },
    });
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => ({
      content: [{ type: "text", text: "answered anyway" }],
    }));

    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "" });
    expect(await agent.handleMessage("see http://127.0.0.1:1/dead please")).toBe("answered anyway");
  });
});
