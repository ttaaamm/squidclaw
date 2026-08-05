import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { SemanticMemory } from "@squidclaw/memory";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

/**
 * Active memory + action-aware extraction: the actual bug behind "I told
 * him to SSH again and he forgot" — SSH was a tool action, never words in
 * the reply, so the passive ear had nothing to extract; and even if it had,
 * a flat first-N-alphabetically digest could bury it under 20 other notes.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });

describe("active memory in the system prompt", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "active-mem-"));
    clearNodes();
    registerBuiltinNodes();
  });

  it("surfaces the message-relevant memory even when the store is full of unrelated ones", async () => {
    const memory = new SemanticMemory(dir);
    memory.remember("my-human", "Tamer, builder of agents");
    memory.remember("preplix-ssh", "SSH into Tamer's server: ssh preplix-prod (key-based, works).");
    for (let i = 0; i < 25; i++) memory.remember(`filler-${i}`, `Filler memory number ${i}, about nothing important.`);

    const systems: string[] = [];
    const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      systems.push(String((req as { system?: string }).system ?? ""));
      return says("ok");
    });
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", memory });

    await agent.handleMessage("can you ssh into my server again?");
    // The identity memory and the one relevant memory both made it in,
    // despite 25 alphabetically-earlier filler entries crowding the store.
    expect(systems[0]).toContain("my-human");
    expect(systems[0]).toContain("preplix-ssh");
  });
});

describe("the passive ear sees what actually happened, not just what was said", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "active-mem-"));
    clearNodes();
    registerBuiltinNodes();
    registerNode({
      name: "remote.connect",
      description: "",
      inputSchema: { type: "object", required: ["host", "command"], properties: { host: { type: "string" }, command: { type: "string" } } },
      run: async () => [{ json: { ok: true, stdout: "connected" } }],
    });
  });

  it("extraction receives the tool actions, so a silent success can still become a memory", async () => {
    const memory = new SemanticMemory(dir);
    let extractionPrompt = "";
    let call = 0;
    const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      call++;
      if (call === 1) return { content: [{ type: "tool_use", id: "t1", name: "remote__connect", input: { host: "76.13.49.186", command: "uptime" } }] };
      if (call === 2) return says("Done — connected."); // the reply says almost nothing about HOW
      extractionPrompt = JSON.stringify((req as { messages: unknown[] }).messages);
      return says('{"facts":[{"name":"preplix-ssh","content":"SSH into 76.13.49.186 works via remote.connect."}]}');
    });
    const agent = new Agent({ brains: mind, journal: new Journal(":memory:"), tenantId: "t", innerMe: "me", memory });

    await agent.handleMessage("ssh into my server and check uptime");
    await new Promise((r) => setTimeout(r, 30)); // extraction is fire-and-forget

    expect(extractionPrompt).toContain("TOOLS ACTUALLY RUN");
    expect(extractionPrompt).toContain("76.13.49.186");
    expect(memory.all().map((m) => m.name)).toContain("preplix-ssh");
  });
});
