import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

function scriptedBrains(responses: unknown[]): Brains {
  let i = 0;
  return new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => responses[i++]);
}

describe("improviser", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("executes tool calls as journaled steps, then replies", async () => {
    const journal = new Journal(":memory:");
    const brains = scriptedBrains([
      { content: [{ type: "tool_use", id: "tu1", name: "echo", input: { value: "ping" } }] },
      { content: [{ type: "text", text: "done: ping" }] },
    ]);
    const agent = new Agent({ brains, journal, tenantId: "t1", innerMe: "You are a test agent." });

    const reply = await agent.handleMessage("please echo ping");
    expect(reply).toBe("done: ping");

    const [rec] = journal.list({ tenantId: "t1" });
    expect(rec.kind).toBe("improvised");
    expect(rec.status).toBe("ok");
    expect(rec.steps).toHaveLength(1);
    expect(rec.steps[0].node).toBe("echo");
    expect(rec.steps[0].output[0].json.value).toBe("ping");
    expect(rec.graph.nodes).toHaveLength(1);
  });

  it("maps dotted node names to legal tool names and records failures", async () => {
    const journal = new Journal(":memory:");
    const brains = scriptedBrains([
      { content: [{ type: "tool_use", id: "tu1", name: "http__request", input: { url: "http://127.0.0.1:1/" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const agent = new Agent({ brains, journal, tenantId: "t1", innerMe: "s" });

    await agent.handleMessage("fetch x");

    const [rec] = journal.list();
    expect(rec.steps[0].node).toBe("http.request");
    expect(rec.steps[0].status).toBe("error");
  });
});
