import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { delegateNode } from "@squidclaw/agent";

/**
 * Multi-agent orchestration: specialists spawn in parallel, answer their
 * one assignment, and report back — journaled like all thinking.
 */

function mindByAssignment() {
  return new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    const text = JSON.stringify((req as { messages: unknown[] }).messages);
    if (text.includes("COUNT-THE-FLOWS")) return { content: [{ type: "text", text: "there are five flows" }] };
    if (text.includes("NAME-THE-BOT")) return { content: [{ type: "text", text: "the bot is Superclaw" }] };
    return { content: [{ type: "text", text: "unknown assignment" }] };
  });
}

describe("agent.delegate", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("runs specialists in parallel and returns each one's answer with its role", async () => {
    const journal = new Journal(":memory:");
    const node = delegateNode({ brains: mindByAssignment(), journal, tenantId: "t" });

    const out = await node.run({
      tasks: [
        { role: "an auditor", task: "COUNT-THE-FLOWS please" },
        { role: "a historian", task: "NAME-THE-BOT please" },
      ],
    }, [], { tenantId: "t" });

    expect(out.map((o) => o.json)).toEqual([
      { role: "an auditor", answer: "there are five flows" },
      { role: "a historian", answer: "the bot is Superclaw" },
    ]);

    // Everything is an execution: each specialist's thinking is journaled.
    expect(journal.list({ tenantId: "t" })).toHaveLength(2);
  });

  it("caps the fleet at three and refuses empty assignments", async () => {
    const journal = new Journal(":memory:");
    const node = delegateNode({ brains: mindByAssignment(), journal, tenantId: "t" });

    const five = await node.run({
      tasks: Array.from({ length: 5 }, (_, i) => ({ role: `r${i}`, task: "NAME-THE-BOT" })),
    }, [], { tenantId: "t" });
    expect(five).toHaveLength(3); // three specialists, never an army

    await expect(node.run({ tasks: [{ role: "x" }] }, [], { tenantId: "t" }))
      .rejects.toThrow(/self-contained assignment/);
  });

  it("one failing specialist reports its error; the others still answer", async () => {
    const journal = new Journal(":memory:");
    const flaky = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      const text = JSON.stringify((req as { messages: unknown[] }).messages);
      if (text.includes("EXPLODE")) throw new Error("specialist meltdown");
      return { content: [{ type: "text", text: "fine here" }] };
    });
    const node = delegateNode({ brains: flaky, journal, tenantId: "t" });

    const out = await node.run({
      tasks: [{ role: "a", task: "EXPLODE" }, { role: "b", task: "steady work" }],
    }, [], { tenantId: "t" });

    // The classic loop turns a brain failure into an honest answer string,
    // so both specialists report — nobody's meltdown is silent.
    expect(out).toHaveLength(2);
    expect(String((out[0].json as { answer?: string }).answer ?? (out[0].json as { error?: string }).error))
      .toContain("meltdown");
    expect((out[1].json as { answer?: string }).answer).toBe("fine here");
  });
});
