import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

function recordingBrains(responses: unknown[]) {
  const seen: Array<{ system: string; messages: unknown[] }> = [];
  let i = 0;
  const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    seen.push({ system: req.system as string, messages: req.messages as unknown[] });
    return responses[i++] ?? { content: [{ type: "text", text: "ok" }] };
  });
  return { brains, seen };
}

describe("the discipline layer", () => {
  beforeEach(clearNodes);

  it("carries craft rules, the current date, and the surface into every prompt", async () => {
    const { brains, seen } = recordingBrains([]);
    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "I am Sanad." });

    await agent.handleMessage("hello", "c1", undefined, { surface: "whatsapp" });

    const system = seen[0].system;
    expect(system).toContain("I am Sanad."); // identity first
    expect(system).toContain("## Discipline"); // craft always
    expect(system).toContain("Act first");
    expect(system).toContain("Arabic gets Arabic");
    expect(system).toContain(new Date().toISOString().slice(0, 10)); // it knows today
    expect(system).toContain("speaking on whatsapp"); // and where it is
  });

  it("gives a huge tool result a haircut instead of flooding the context", async () => {
    registerNode({
      name: "bigdump", description: "returns a lot", inputSchema: {},
      run: async () => [{ json: { text: "x".repeat(50_000) } }],
    });
    const { brains, seen } = recordingBrains([
      { content: [{ type: "tool_use", id: "t1", name: "bigdump", input: {} }] },
      { content: [{ type: "text", text: "summarised" }] },
    ]);
    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "" });

    await agent.handleMessage("dump it");

    const second = seen[1].messages as Array<{ content: unknown }>;
    const toolResult = (second.at(-1)!.content as Array<{ content: string }>)[0].content;
    expect(toolResult.length).toBeLessThan(4_000);
    expect(toolResult).toContain("[trimmed");
  });
});
