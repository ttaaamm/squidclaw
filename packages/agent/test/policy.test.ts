import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, registerNode, Journal, type Item } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent, executeTool, GUARDED_TOOLS, PolicyRefusal, scopePolicy, type ToolPolicy } from "@squidclaw/agent";

/**
 * The tool policy gate: one door every call walks through. Malformed and
 * placeholder-shaped calls are refused with a sentence the model can act on
 * — uniformly, not per-flow, whichever mind is calling.
 */

const scripted = (responses: unknown[]): Brains => {
  let i = 0;
  return new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => responses[i++] ?? { content: [{ type: "text", text: "ok" }] });
};

describe("executeTool — the gate itself", () => {
  const ran: Array<Record<string, unknown>> = [];
  const sendTool = {
    name: "msg.send",
    description: "",
    inputSchema: { type: "object", required: ["to", "body"], properties: { to: { type: "string" }, body: { type: "string" } } },
    run: async (params: Record<string, unknown>) => { ran.push(params); return [{ json: { sent: true } }] as Item[]; },
  };

  beforeEach(() => { ran.length = 0; });

  it("refuses a call missing a required field, naming it", async () => {
    await expect(executeTool(sendTool, { to: "ash" }, { tenantId: "t" }))
      .rejects.toThrow(/needs "body"/);
    expect(ran).toHaveLength(0);
  });

  it("refuses placeholder-shaped values before the tool ever runs", async () => {
    for (const bad of ["<recipient name>", "TODO", "placeholder"]) {
      await expect(executeTool(sendTool, { to: bad, body: "hi" }, { tenantId: "t" }))
        .rejects.toThrow(PolicyRefusal);
    }
    expect(ran).toHaveLength(0);
  });

  it("lets honest calls through and runs after-hooks", async () => {
    const stamp: ToolPolicy = {
      name: "stamp",
      after: (_t, _p, output) => output.map((i) => ({ json: { ...i.json, stamped: true } })),
    };
    const out = await executeTool(sendTool, { to: "ash", body: "hi" }, { tenantId: "t" }, [stamp]);
    expect(ran).toHaveLength(1);
    expect(out[0].json).toEqual({ sent: true, stamped: true });
  });

  it("a custom before-policy can veto by tool name", async () => {
    const noSends: ToolPolicy = {
      name: "no-sends",
      before: (tool) => { if (tool === "msg.send") throw new PolicyRefusal("sending is disabled for this tenant"); },
    };
    await expect(executeTool(sendTool, { to: "a", body: "b" }, { tenantId: "t" }, [noSends]))
      .rejects.toThrow(/disabled/);
    expect(ran).toHaveLength(0);
  });
});

describe("the gate inside the agent loop", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("a refused call reaches the model as a readable error, and the tool never runs", async () => {
    let toolRan = false;
    registerNode({
      name: "ping.send", description: "", inputSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
      run: async () => { toolRan = true; return [{ json: {} }]; },
    });
    const journal = new Journal(":memory:");
    const agent = new Agent({
      brains: scripted([
        { content: [{ type: "tool_use", id: "t1", name: "ping__send", input: {} }] }, // forgot target
        { content: [{ type: "text", text: "understood, I will ask" }] },
      ]),
      journal, tenantId: "t1", innerMe: "test",
    });

    const reply = await agent.handleMessage("ping someone");
    expect(reply).toBe("understood, I will ask");
    expect(toolRan).toBe(false);

    const [rec] = journal.list({ tenantId: "t1" });
    expect(rec.steps[0].status).toBe("error");
    expect(rec.steps[0].error).toContain('needs "target"');
  });
});

describe("operator scopes", () => {

  it("guarded tools refuse without the named grant — and say which one", () => {
    const policy = scopePolicy(["email"]);
    expect(() => policy.before!("ssh.exec", {})).toThrow(/"ssh" scope/);
    expect(() => policy.before!("email.send", {})).not.toThrow();
    expect(() => policy.before!("web.search", {})).not.toThrow(); // unguarded stays free
  });

  it("no scopes recorded, or *, means everything — the founding-tenant reality", () => {
    for (const scopes of [undefined, ["*"]]) {
      const policy = scopePolicy(scopes);
      for (const tool of Object.keys(GUARDED_TOOLS)) {
        expect(() => policy.before!(tool, {})).not.toThrow();
      }
    }
  });
});
