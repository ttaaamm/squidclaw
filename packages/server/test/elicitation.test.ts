import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode, type Item } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { missingParams, resolveArgs, elicitFrom, type Flow } from "@squidclaw/agent";
import { Platform } from "./../src/platform.js";

/**
 * Flow contracts + platform elicitation: asking for missing details is a
 * GUARANTEE of the platform, not a behavior we hope the model remembers.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });
const calls = (name: string, input: Record<string, unknown>) => ({
  content: [{ type: "tool_use", id: "t1", name, input }],
});

const CARD_FLOW: Flow = {
  name: "card",
  description: "Makes a branded card.",
  signature: "native:card",
  triggers: [],
  params: [
    { name: "title", ask: "What should the card say?", reject: "^(tst|test)\\s*(post|card)?$" },
    { name: "size", options: ["post", "story"], default: "post" },
    { name: "notes", default: "" },
  ],
  runs: 2,
  createdAt: "now",
  status: "promoted",
  graph: { nodes: [{ id: "make-1", node: "capture.args", params: { title: "{{title}}", size: "{{size}}" } }], edges: [] },
};

describe("param contracts", () => {
  it("knows what the human still owes — missing, placeholder, or off the menu", () => {
    expect(missingParams(CARD_FLOW, {}).map((m) => m.name)).toEqual(["title"]);
    expect(missingParams(CARD_FLOW, { title: "Test Post" }).map((m) => m.name)).toEqual(["title"]); // placeholder
    expect(missingParams(CARD_FLOW, { title: "Real News", size: "banner" }).map((m) => m.name)).toEqual([]); // bad option → default
    expect(missingParams(CARD_FLOW, { title: "Real News" })).toEqual([]);
  });

  it("resolves defaults and normalizes options", () => {
    const args = resolveArgs(CARD_FLOW, { title: "Real News", size: "STORY" });
    expect(args.size).toBe("story");
    expect(args.notes).toBe("");
  });

  it("builds the interview request, keeping what was already given", () => {
    const req = elicitFrom(CARD_FLOW, { title: "tst post", size: "story" })!;
    expect(req.flow).toBe("card");
    expect(req.given).toEqual({ size: "story" });
    expect(req.missing[0]).toEqual({ name: "title", ask: "What should the card say?" });
  });
});

describe("the platform interview", () => {
  const captured: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
    captured.length = 0;
    registerNode({
      name: "capture.args", description: "", inputSchema: {},
      run: async (params) => { captured.push(params); return [{ json: { made: true } }] as Item[]; },
    });
  });

  async function platformWithCardFlow(mindScript: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), "elicit-"));
    writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
    let i = 0;
    const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => mindScript[i++] ?? says("ok"));
    const platform = new Platform({ root, mind, via: "cli", adminChats: ["telegram:999"] });
    const invite = (await platform.handle("telegram", "999", "/tenant new Elicit")).match(/\/join (\S+)/)![1];
    await platform.handle("telegram", "111", `/join ${invite}`);
    for (const a of ["Agent", "human", "testing", "warm"]) await platform.handle("telegram", "111", a);
    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    const org = await platform.organismFor(id);
    org.flows.saveDraft({ ...CARD_FLOW, status: "draft" });
    org.flows.promote("card");
    org.agent.registerHabits();
    return platform;
  }

  it("mind calls with a placeholder → platform asks, human answers, flow runs with the real value", async () => {
    const platform = await platformWithCardFlow([
      calls("flow__card", { title: "test post" }), // the genie move
      says("should never be reached"),
    ]);

    // The model's turn ends; the platform asks its own canonical question.
    const ask = await platform.handle("telegram", "111", "make me a card");
    expect(ask).toContain("What should the card say?");
    expect(ask).toContain("/cancel");
    expect(captured).toHaveLength(0); // the flow did NOT run

    // The next message is the answer — no model involved, contract satisfied.
    const done = await platform.handle("telegram", "111", "Preplix launches SquidClaw");
    expect(done).toBe(""); // the flow's own output is the reply
    expect(captured).toHaveLength(1);
    expect(captured[0].title).toBe("Preplix launches SquidClaw");
    expect(captured[0].size).toBe("post"); // default applied
    platform.stop();
  });

  it("placeholder answers are refused and re-asked; /cancel ends the interview", async () => {
    const platform = await platformWithCardFlow([calls("flow__card", {})]);

    await platform.handle("telegram", "111", "make me a card");
    // A placeholder answer hits the same reject gate and gets re-asked.
    const again = await platform.handle("telegram", "111", "tst post");
    expect(again).toContain("What should the card say?");
    expect(captured).toHaveLength(0);

    expect(await platform.handle("telegram", "111", "/cancel")).toContain("Cancelled");
    expect(captured).toHaveLength(0);
    platform.stop();
  });

  it("asks each question in turn when several details are missing", async () => {
    const flow: Flow = {
      ...CARD_FLOW,
      name: "invite",
      signature: "native:invite",
      params: [
        { name: "who", ask: "Who is it for?" },
        { name: "when", ask: "When is it?" },
      ],
      graph: { nodes: [{ id: "m", node: "capture.args", params: { who: "{{who}}", when: "{{when}}" } }], edges: [] },
    };
    const platform = await platformWithCardFlow([calls("flow__invite", {})]);
    const org = await platform.organismFor(platform.tenants.tenantFor("telegram", "111")!.id);
    org.flows.saveDraft({ ...flow, status: "draft" });
    org.flows.promote("invite");
    org.agent.registerHabits();

    expect(await platform.handle("telegram", "111", "invite someone")).toContain("Who is it for?");
    expect(await platform.handle("telegram", "111", "Ash")).toContain("When is it?");
    expect(await platform.handle("telegram", "111", "tomorrow 8pm")).toBe("");
    expect(captured[0]).toMatchObject({ who: "Ash", when: "tomorrow 8pm" });
    platform.stop();
  });
});
