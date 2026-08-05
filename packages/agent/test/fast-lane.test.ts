import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

/**
 * The fast lane: one cheap breath before the deep machinery. Casual
 * messages answer in seconds; anything real self-escalates. A stumble on
 * the fast lane must never cost more than falling through.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });

function mindRecordingTiers(script: Record<string, string>) {
  const tiers: string[] = [];
  const mind = new Brains({ tiers: { cheap: ["haiku"], strong: ["sonnet"] } }, async (req) => {
    const model = String((req as { model?: string }).model ?? "");
    tiers.push(model);
    return says(script[model] ?? "?");
  });
  return { mind, tiers };
}


describe("the fast lane", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("answers a casual message with one cheap call — the deep mind never wakes", async () => {
    const { mind, tiers } = mindRecordingTiers({ haiku: "أهلاً تامر! كله تمام 🐙" });
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", fastLane: true });

    const reply = await agent.handleMessage("هلا، شلونك؟");
    expect(reply).toBe("أهلاً تامر! كله تمام 🐙");
    expect(tiers).toEqual(["haiku"]); // one breath, nothing else
  });

  it("escalates real work: the fast model says so, the strong loop delivers", async () => {
    const { mind, tiers } = mindRecordingTiers({ haiku: "<ESCALATE>", sonnet: "the report is written" });
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", fastLane: true });

    const reply = await agent.handleMessage("research the market and write me a report");
    expect(reply).toBe("the report is written");
    expect(tiers[0]).toBe("haiku"); // triage first
    expect(tiers).toContain("sonnet"); // then the real work
  });

  it("a fast-lane stumble means escalation, never an error", async () => {
    let first = true;
    const mind = new Brains({ tiers: { cheap: ["haiku"], strong: ["sonnet"] } }, async () => {
      if (first) { first = false; throw new Error("fast lane tripped"); }
      return says("caught by the deep lane");
    });
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", fastLane: true });

    expect(await agent.handleMessage("hello?")).toBe("caught by the deep lane");
  });

  it("stays out of the way when deep thinking is not configured", async () => {
    const { mind, tiers } = mindRecordingTiers({ sonnet: "classic answer" });
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me" });

    expect(await agent.handleMessage("hi")).toBe("classic answer");
    expect(tiers).toEqual(["sonnet"]); // no triage detour without the slow lane
  });
});
