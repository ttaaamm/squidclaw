import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode, getNode, Journal, type Item } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { Agent, FlowStore, type Flow } from "@squidclaw/agent";

const dir = () => mkdtempSync(join(tmpdir(), "iso-"));

const habit = (name: string, marker: string): Flow => ({
  name, description: `habit belonging to ${marker}`, signature: "secret.node",
  triggers: [], params: [], runs: 2, createdAt: "now", status: "draft",
  graph: { nodes: [{ id: "n1", node: "secret.node", params: { owner: marker } }], edges: [] },
});

function agentWith(flows: FlowStore, seen: string[][]) {
  const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    seen.push(((req.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
    return { content: [{ type: "text", text: "ok" }] };
  });
  return new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "", flows });
}

describe("one tenant's habits never leak into another's", () => {
  beforeEach(() => {
    clearNodes();
    registerNode({
      name: "secret.node", description: "shared builtin", inputSchema: {},
      run: async (p): Promise<Item[]> => [{ json: { ran: p.owner } }],
    });
  });

  it("shows each agent only its own skills", async () => {
    const alJood = new FlowStore(dir());
    alJood.saveDraft(habit("invoice", "al-jood"));
    alJood.promote("invoice");

    const saudiTimes = new FlowStore(dir());
    saudiTimes.saveDraft(habit("instagram-post", "saudi-times"));
    saudiTimes.promote("instagram-post");

    const seenA: string[][] = [];
    const seenB: string[][] = [];
    const agentA = agentWith(alJood, seenA);
    const agentB = agentWith(saudiTimes, seenB);

    await agentA.handleMessage("hello");
    await agentB.handleMessage("hello");

    expect(seenA[0]).toContain("flow__invoice");
    expect(seenA[0]).not.toContain("flow__instagram-post");

    expect(seenB[0]).toContain("flow__instagram-post");
    expect(seenB[0]).not.toContain("flow__invoice");

    // Both still share the builtin tools.
    expect(seenA[0]).toContain("secret__node");
    expect(seenB[0]).toContain("secret__node");
  });

  it("keeps habits out of the global registry entirely", () => {
    const flows = new FlowStore(dir());
    flows.saveDraft(habit("private-thing", "al-jood"));
    flows.promote("private-thing");

    const agent = agentWith(flows, []);

    // The habit is reachable through its own agent…
    expect(agent.habit("private-thing")).toBeDefined();
    expect(agent.habit("flow.private-thing")).toBeDefined();
    // …but invisible to anyone reading the shared registry.
    expect(getNode("flow.private-thing")).toBeUndefined();
  });

  it("lets two tenants hold habits of the same name meaning different things", async () => {
    const a = new FlowStore(dir());
    a.saveDraft(habit("daily-report", "al-jood"));
    a.promote("daily-report");

    const b = new FlowStore(dir());
    b.saveDraft(habit("daily-report", "saudi-times"));
    b.promote("daily-report");

    const agentA = agentWith(a, []);
    const agentB = agentWith(b, []);

    const outA = await agentA.habit("daily-report")!.run({}, [], { tenantId: "t" });
    const outB = await agentB.habit("daily-report")!.run({}, [], { tenantId: "t" });

    expect(outA[0].json.ran).toBe("al-jood");
    expect(outB[0].json.ran).toBe("saudi-times");
  });
});
