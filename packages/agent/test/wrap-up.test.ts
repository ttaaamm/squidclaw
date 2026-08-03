import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

describe("running out of turns", () => {
  beforeEach(() => {
    clearNodes();
    registerNode({
      name: "echo", description: "echoes", inputSchema: {},
      run: async (p) => [{ json: { ...p } }],
    });
  });

  it("concludes with a real answer instead of apologising about turn limits", async () => {
    const calls: Array<{ hasTools: boolean; lastUser: string }> = [];
    // A mind stuck in a loop: it calls a tool every single turn, forever.
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      const messages = req.messages as Array<{ role: string; content: unknown }>;
      const last = messages.at(-1);
      calls.push({
        hasTools: Array.isArray(req.tools) && (req.tools as unknown[]).length > 0,
        lastUser: typeof last?.content === "string" ? last.content : "",
      });
      if (req.tools) {
        return { content: [{ type: "tool_use", id: `t${calls.length}`, name: "echo", input: { n: calls.length } }] };
      }
      return { content: [{ type: "text", text: "Here's what I managed to find." }] };
    });

    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "" });
    const reply = await agent.handleMessage("do something endless");

    expect(reply).toBe("Here's what I managed to find.");
    expect(reply).not.toContain("thinking turns");

    // The wrap-up call is the only one without tools, and it says stop.
    const wrapUp = calls.at(-1)!;
    expect(wrapUp.hasTools).toBe(false);
    expect(wrapUp.lastUser).toContain("no more tools");
  });
});
