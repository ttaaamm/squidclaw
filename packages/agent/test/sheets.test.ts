import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent, FlowStore } from "@squidclaw/agent";

/**
 * Flow instruction sheets — a flow's own SKILL.md, loaded into the mind's
 * context only when the message touches its territory.
 */

function mindRecordingSystem() {
  const systems: string[] = [];
  const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    systems.push(String((req as { system?: string }).system ?? ""));
    return { content: [{ type: "text", text: "ok" }] };
  });
  return { mind, systems };
}

function storeWithCardFlow() {
  const dir = mkdtempSync(join(tmpdir(), "sheets-"));
  const store = new FlowStore(dir);
  store.saveDraft({
    name: "card", description: "Makes a branded card.", signature: "s", triggers: [], params: [],
    runs: 2, createdAt: "now", status: "draft", graph: { nodes: [], edges: [] },
  });
  store.promote("card");
  writeFileSync(join(dir, "card.md"),
    "when: poster, artwork\nAlways confirm the size before rendering. Landscape photos only.\n");
  return store;
}

describe("flow instruction sheets", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("reads a sheet with its relevance cues", () => {
    const store = storeWithCardFlow();
    const sheet = store.sheetFor("card")!;
    expect(sheet.when).toEqual(["poster", "artwork"]);
    expect(sheet.body).toContain("confirm the size");
    expect(store.sheetFor("nope")).toBeUndefined();
  });

  it("loads the sheet when the message touches its territory — and only then", async () => {
    const store = storeWithCardFlow();
    const { mind, systems } = mindRecordingSystem();
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", flows: store });

    await agent.handleMessage("make me a poster for the launch");
    expect(systems[0]).toContain("How to use flow.card");
    expect(systems[0]).toContain("Always confirm the size");

    systems.length = 0;
    await agent.handleMessage("what is the weather like?");
    expect(systems[0]).not.toContain("How to use flow.card");
  });

  it("the flow's own name is always a cue", async () => {
    const store = storeWithCardFlow();
    const { mind, systems } = mindRecordingSystem();
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", flows: store });

    await agent.handleMessage("run the card thing again");
    expect(systems[0]).toContain("How to use flow.card");
  });
});
